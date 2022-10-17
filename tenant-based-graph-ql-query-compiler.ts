import { ArgumentNode, GraphQLObjectType, ValueNode } from "graphql";
import { GraphQlQueryCompiler } from "./graph-ql-query-compiler";
import { ConnectionSuffixRegex } from "./models";

const fieldsWithoutFilters = ["sentBy", "includedIn", "updatedBy", "proposedBy", "creator", "sentBy", "mappingInstances"];
export class TenantBasedGraphQlQueryCompiler extends GraphQlQueryCompiler {
	protected createConditionTreesByField(args: ReadonlyArray<ArgumentNode> | undefined, fieldType: GraphQLObjectType, fieldName: string) {
		const targetType = this.getTargetIfConnectionType(fieldType);
		const fields = targetType.getFields();

		if (
			(!("tenantId" in fields) && !("tenantIds" in fields)) ||
			["FlexEntity"].includes(fieldType.name) ||
			fieldsWithoutFilters.includes(fieldName)
		) {
			return super.createConditionTreesByField(args, fieldType, fieldName);
		}

		const whereArg = args?.find((arg) => arg.name.value === "where");
		const tenantCondition: ValueNode =
			"tenantId" in fields
				? {
						kind: "ObjectValue",
						fields: [
							{
								kind: "ObjectField",
								name: {
									kind: "Name",
									value: "tenantId",
								},
								value: {
									kind: "Variable",
									name: {
										kind: "Name",
										value: "cypherParams.tenantId",
									},
								},
							},
						],
				  }
				: {
						kind: "ObjectValue",
						fields: [
							{
								kind: "ObjectField",
								name: {
									kind: "Name",
									value: "tenantIds_INCLUDES",
								},
								value: {
									kind: "Variable",
									name: {
										kind: "Name",
										value: "cypherParams.tenantId",
									},
								},
							},
						],
				  };
		const nodeCondition: ValueNode = ConnectionSuffixRegex.test(fieldName)
			? {
					kind: "ObjectValue",
					fields: [
						{
							kind: "ObjectField",
							name: {
								kind: "Name",
								value: "node",
							},
							value: tenantCondition,
						},
					],
			  }
			: tenantCondition;
		const extendedWhereArgumentValue: ValueNode = whereArg
			? {
					kind: "ObjectValue",
					fields: [
						{
							kind: "ObjectField",
							name: {
								kind: "Name",
								value: "AND",
							},
							value: {
								kind: "ListValue",
								values: [whereArg.value, nodeCondition],
							},
						},
					],
			  }
			: nodeCondition;
		const extendedWhereArgument: ArgumentNode = {
			kind: "Argument",
			name: {
				kind: "Name",
				value: "where",
			},
			value: extendedWhereArgumentValue,
		};

		const newArgs = args?.some((arg) => arg.name.value === "where")
			? (args || []).map((arg) => (arg.name.value === "where" ? extendedWhereArgument : arg))
			: [...(args || []), extendedWhereArgument];
		return super.createConditionTreesByField(newArgs, fieldType, fieldName);
	}
}
