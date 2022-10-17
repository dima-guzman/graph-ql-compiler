import { differenceInMilliseconds } from "date-fns";
import { GraphQLObjectType, GraphQLResolveInfo, isObjectType } from "graphql";
import { ContextProps } from "../../models/context";
import Logger from "../../shared/logger";
import { runInSession } from "../../shared/run-in-session";
import { FlexEntityDataPointsService } from "../data-points/flex-entity-data-points.service";
import { GraphQlExtensionService } from "./graph-ql-extension-service";
import { GraphQlQueryTraverse } from "./graph-ql-query-traverse";
import { TenantBasedGraphQlQueryCompiler } from "./tenant-based-graph-ql-query-compiler";
import { unwrapType } from "./utils";

export const tenantBasedQueryResolver = async (_obj: any, args: any, context: ContextProps, info: GraphQLResolveInfo) => {
	try {
		const compiler = new TenantBasedGraphQlQueryCompiler(info.schema, { ...info.variableValues, ...args });
		const traverse = new GraphQlQueryTraverse(info, compiler);
		traverse.walk(info.operation);
		const query = compiler.compile();
		const date = new Date();
		const data = await runInSession(async (session) => {
			const response = await session.run(query, { cypherParams: context.cypherParams, ...info.variableValues });
			return response.records.map((record) => record.get(0));
		});
		console.info({ query: info.operation.name?.value, completedIn: differenceInMilliseconds(new Date(), date) });
		const dataWithExtensionsApplied = new GraphQlExtensionService(info).applyExtensionsRoot(data);
		const rootField = (info.schema.getType("Query") as GraphQLObjectType)?.getFields()[info.fieldName];
		const rootFieldType = unwrapType(rootField.type);
		if (/^[A-Z]/.test(info.fieldName) || (isObjectType(rootFieldType) && "tenantId" in rootFieldType.getFields())) {
			return dataWithExtensionsApplied;
		}

		const dataPointService = new FlexEntityDataPointsService();
		return dataPointService.resolveRootQuery(dataWithExtensionsApplied, context, info);
	} catch (error) {
		Logger.error(error);
		Logger.error((error as Error).stack);
		throw error;
	}
};
