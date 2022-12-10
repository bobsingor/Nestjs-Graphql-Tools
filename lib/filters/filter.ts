import { Args, Field, InputType, PartialType, ReturnTypeFunc, TypeMetadataStorage } from "@nestjs/graphql";
import { BaseEntity } from "../common";
import { FILTER_DECORATOR_CUSTOM_FIELDS_METADATA_KEY, FILTER_DECORATOR_NAME_METADATA_KEY, FILTER_OPERATION_PREFIX } from "./constants";
import { CUSTOM_FILTER_INPUT_TYPE_DECORATOR_NAME, FilterInputTypeDecoratorMetadata, FilterInputTypeFieldMetadata } from "./filter.input-type";
import { convertArrayOfStringIntoStringNumber } from "./utils";

export enum OperationQuery {
  eq = 'eq',
  neq = 'neq',
  gt = 'gt',
  gte = 'gte',
  lt = 'lt',
  lte = 'lte',
  in = 'in',
  notin = 'notin',
  like = 'like',
  notlike = 'notlike',
  between = 'between',
  notbetween = 'notbetween',
  null = 'null',
}

const arrayLikeOperations = new Set([OperationQuery.between, OperationQuery.notbetween, OperationQuery.in]);

export enum InputMapPrefixes {
  PropertyFilterType = 'PropertyFilterType',
  FilterInputType = 'FilterInputType',
}

export interface FilterFieldDefinition {
  /** Filter name. This name will be shown in the playground */
  name: string;
  /** Graphql type function. Basic types Int, String, Boolean, GraphQLISODateTime. Example value () => String */
  typeFn: ReturnTypeFunc;
} 

export interface CustomFilterFieldDefinition extends FilterFieldDefinition {
  /** Left side of conditional sql expression. 
   * Examples: 
   * 1. Select * from task t where t.title ilike '%test%'. Statement t.title is the left side of a statement 
   * 2. Select * from user u where concat(u.fname, ' ', u.lname) ilike %alex%. Statement concat(u.fname, ' ', u.lname) is the left side of the conditional statement*/
  sqlExp: string;
} 

export interface IFilterDecoratorParams {
  name?: string;
}


const filterFullTypes = new Map();
const filterTypes = new Map();
const propertyTypes = new Map()

const generateFilterPropertyType = (field, parentName: string) => {
  const key = `${field.name}${parentName}${InputMapPrefixes.PropertyFilterType}`;

  const propType = propertyTypes.get(key);
  if (propType) return propType;

  class PropertyFilter {}
  InputType(key, {isAbstract: true})(PropertyFilter);

  Object.keys(OperationQuery).forEach(operationName => {
    field.typeFn();
    Field(() => {
      if (arrayLikeOperations.has(OperationQuery[operationName])) {
        return [field.typeFn()];
      } if ([OperationQuery.null].includes(OperationQuery[operationName])) {
        return Boolean;
      } else {
        return field.typeFn();
      }
    }
    , {...field.options, nullable: true})(PropertyFilter.prototype, FILTER_OPERATION_PREFIX ? `${FILTER_OPERATION_PREFIX}${operationName}` : operationName);
  })

  Object.defineProperty(PropertyFilter, 'name', {
    value: key,
  });

  propertyTypes.set(key, PropertyFilter);
  return PropertyFilter;
}

function generateFilterInputType<T extends BaseEntity>(classes: T[]) {
  const concatinatedClassNames = classes.map(x => x.name).join('')
  const key = `${concatinatedClassNames}${InputMapPrefixes.PropertyFilterType}`;
  if (filterTypes.get(key)) {
    return filterTypes.get(key);
  }

  class PartialObjectType {}
  InputType(key, {isAbstract: true})(PartialObjectType);
  
  Object.defineProperty(PartialObjectType, 'name', {
    value: key,
  });

  filterTypes.set(key, PartialObjectType);

  const properties: FilterFieldDefinition[] = [];

  for (const typeFn of classes) {
    const customFilterData: FilterInputTypeDecoratorMetadata = Reflect.getMetadata(CUSTOM_FILTER_INPUT_TYPE_DECORATOR_NAME, typeFn.prototype)
    if (customFilterData) {
      const props = customFilterData.fields.map(x => ({name: x.name, typeFn: x.typeFn, qlExp: x.options.sqlExp}));
      properties.push(...props);
    } else {
      PartialType(typeFn, InputType); // cast to input type
      const classMetadata = TypeMetadataStorage.getObjectTypeMetadataByTarget(typeFn);
      TypeMetadataStorage.loadClassPluginMetadata([classMetadata]);
      TypeMetadataStorage.compileClassMetadata([classMetadata]);

      const objectTypesMetadata = TypeMetadataStorage.getObjectTypesMetadata();
      const inheritedType = objectTypesMetadata.find(x => x.target.name === typeFn?.__extension__);
      
      if (inheritedType) {
        // Compile inherited type
        TypeMetadataStorage.loadClassPluginMetadata([inheritedType]);
        TypeMetadataStorage.compileClassMetadata([inheritedType]);
      }

      if (!classMetadata?.properties) {
        throw new Error(`DTO ${typeFn.name} hasn't been initialized yet`)
      }
    
    
      properties.push(...(inheritedType?.properties || []), ...classMetadata.properties)
    }
  }

  for (const field of properties) {
    const targetClassMetadata = TypeMetadataStorage.getObjectTypeMetadataByTarget(field.typeFn() as BaseEntity);
    if (!targetClassMetadata) {
      if (typeof field.typeFn === 'function') {
        field.typeFn();
      }
      const fieldType = generateFilterPropertyType(field, concatinatedClassNames);
      Field(() => fieldType, {nullable: true})(PartialObjectType.prototype, field.name)
    } else {
      // Relations are not supported yet
      // let referenceInputType = filterTypes.get(`${field.name}${InputMapPrefixes.PropertyFilterType}`);
      // if (!referenceInputType) {
      //   referenceInputType = generateFilterInputType(field.typeFn() as BaseEntity);
      // }
      // Field(() => referenceInputType, {nullable: true})(PartialObjectType.prototype, field.name)
    }
  }

  return PartialObjectType;
}

export type IFilterField<T> = {
  [K in keyof T]: {
    eq: T[K],
    neq: T[K],
    gt: T[K],
    gte: T[K],
    lt: T[K],
    lte: T[K],
    in: T[K],
    like: T[K],
    notlike: T[K],
    between: T[K],
    notbetween: T[K],
    null: T[K],
  };
}

export interface IFilter<T> {
  and: IFilterField<T>[];
  or: IFilterField<T>[];
  _name_: string;
}

const getFilterFullInputType = (classes: BaseEntity[]) => {
  
  const concatinatedClassName = classes.map(x => x.name).join('')

  const key = `where${concatinatedClassName}Input`; 
  if (filterFullTypes.get(key)) {
    return filterFullTypes.get(key);
  }
  const FilterInputType = generateFilterInputType(classes);
  @InputType(key)
  class EntityWhereInput extends FilterInputType {
    @Field({defaultValue: FILTER_DECORATOR_NAME_METADATA_KEY, description: 'Don\'t touch this field. Reserved for nestjs-graphql-toos purposes.'})
    _name_: string;
    @Field(() => [FilterInputType], {nullable: true})
    and: BaseEntity[];
    @Field(() => [FilterInputType], {nullable: true})
    or: BaseEntity[];
  }
  filterFullTypes.set(key, EntityWhereInput);
  return EntityWhereInput;
}

export const Filter = (baseEntity: () => BaseEntity | BaseEntity[], options?: IFilterDecoratorParams) => {
  // convert params to array
  const extractedResults = baseEntity();
  let typeFunctions = extractedResults as BaseEntity[];
  if (!Array.isArray(extractedResults)) {
    typeFunctions = [extractedResults];
  }
  const filterFullType = getFilterFullInputType(typeFunctions);

  const customFields = typeFunctions.reduce((acc, x) => {
    if (x.prototype.filterInputType) {
      const fields = x.prototype.getFields() as FilterInputTypeFieldMetadata[];
      for (const field of fields) {
        acc.push({
          name: field.name,
          typeFn: field.typeFn,
          sqlExp: field.options.sqlExp
        })
      }
    }
    return acc;
  }, [] as CustomFilterFieldDefinition[]);

  return (target, propertyName, paramIndex) => {
    Reflect.defineMetadata(FILTER_DECORATOR_CUSTOM_FIELDS_METADATA_KEY, customFields, target, propertyName);
    Args({
      name: options?.name || 'where',
      nullable: true,
      defaultValue: {},
      type: () => filterFullType,
    })(target, propertyName, paramIndex);
  }
}


const compressFieldsName = (fields: CustomFilterFieldDefinition[]) => {
  if (!fields?.length) return '';
  
  return convertArrayOfStringIntoStringNumber(fields.map(x => x.name));
}
