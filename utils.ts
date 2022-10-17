import { DirectiveNode, GraphQLOutputType, isListType, isNonNullType, ObjectTypeDefinitionNode } from "graphql";
import { isArray } from "lodash";
import { genTypeDefs } from "../../graphql/graphql-schema";
import { isEmptyValue } from "../../shared/is-empty-value";

export const toCamelCase = (value: string) => `${value[0].toLowerCase()}${value.slice(1)}`;

export const unwrapType = (graphQlType: GraphQLOutputType): GraphQLOutputType =>
	isNonNullType(graphQlType) || isListType(graphQlType) ? unwrapType(graphQlType.ofType) : graphQlType;

export const unwrapNullableType = (graphQlType: GraphQLOutputType): GraphQLOutputType => (isNonNullType(graphQlType) ? graphQlType.ofType : graphQlType);

export const insertBetweenArrayItems = <T>(items: Array<T>, insertion: T): Array<T> =>
	items
		.filter((item) => !isEmptyValue(item) && (!isArray(item) || item.length))
		.flatMap((item, index) => (index > 0 ? [insertion, item] : [item]));

export const typeFieldsToDirectivesMap: { [key: string]: Array<DirectiveNode> } = genTypeDefs.definitions
	.filter((definition) => definition.kind === "ObjectTypeDefinition")
	.flatMap(
		(typeDefinition) =>
			(typeDefinition as ObjectTypeDefinitionNode).fields?.map(
				(field) =>
					[`${(typeDefinition as ObjectTypeDefinitionNode).name.value}.${field.name.value}`, field.directives || []] as [
						string,
						Array<DirectiveNode>
					]
			) || []
	)
	.reduce((a, [key, directives]) => ({ ...a, [key]: directives }), {});
