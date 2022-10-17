import { DocumentNode, FieldNode, FragmentDefinitionNode, GraphQLResolveInfo, GraphQLSchema, OperationDefinitionNode } from "graphql";
import { readAndMap, Runnable } from "../../shared/neo4j-helper";
import { GraphQlQueryCompiler } from "./graph-ql-query-compiler";
import { GraphQlQueryTraverse } from "./graph-ql-query-traverse";

export const graphQlDbReader = async (runnable: Runnable, document: DocumentNode, schema: GraphQLSchema, args: any = {}) => {
	const compiler = new GraphQlQueryCompiler(schema, args);
	const fragments = document.definitions
		.filter((definition) => definition.kind === "FragmentDefinition")
		.reduce(
			(a, c) => ({
				...a,
				[(c as FragmentDefinitionNode).name.value]: c,
			}),
			{}
		);
	const operation = document.definitions.find((definition) => definition.kind === "OperationDefinition") as OperationDefinitionNode;
	const traverse = new GraphQlQueryTraverse(
		{
			fieldName: (operation.selectionSet.selections[0] as FieldNode).name.value,
			operation,
			fragments,
		} as GraphQLResolveInfo,
		compiler
	);
	traverse.walk(operation);
	const query = compiler.compile();
	console.info(query);

	return await readAndMap(runnable, query, (record) => record.get(0), args);
};
