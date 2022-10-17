import { ApolloError } from "apollo-server-errors";
import { format } from "date-fns";
import {
	ArgumentNode,
	ASTNode,
	DirectiveNode,
	EnumValueNode,
	FieldNode,
	GraphQLField,
	GraphQLObjectType,
	GraphQLOutputType,
	GraphQLSchema,
	InlineFragmentNode,
	isEnumType,
	isListType,
	isObjectType,
	isScalarType,
	ListValueNode,
	ObjectFieldNode,
	StringValueNode,
	ValueNode,
} from "graphql";
import { last } from "lodash";
import { castToArray } from "../../shared/cast-to-array";
import { isEmptyValue } from "../../shared/is-empty-value";
import { partition } from "../../shared/partition";
import { OperatorType } from "../agreement/models";
import { IGraphQlQueryVisitor } from "./interfaces";
import { Condition, ConnectionSuffixRegex, OptionsType, RelationshipSuffixRegex, Token } from "./models";
import { insertBetweenArrayItems, toCamelCase, typeFieldsToDirectivesMap, unwrapNullableType, unwrapType } from "./utils";

export class GraphQlQueryCompiler implements IGraphQlQueryVisitor {
	private fieldPath: Array<GraphQLField<any, any>> = [];
	private fieldNodePath: Array<FieldNode> = [];
	private typePath: Array<GraphQLOutputType> = [];
	private listComprehensionFlagPath: Array<"single" | "list" | null> = [];
	private level: number = -1;
	private buffer: Array<string> = [];
	private tokenBuffer: Array<Token> = [];

	constructor(private readonly schema: GraphQLSchema, private readonly variables: any = {}) {
		this.visitOperation();
	}

	compile() {
		this.buffer.push(...this.tokenBuffer.flatMap((token) => token.value));
		this.tokenBuffer = [];
		return this.buffer.join(" ");
	}

	visitOperation() {
		this.fieldPath = [];
		this.fieldNodePath = [];
		this.typePath = [this.schema.getType("Query") as GraphQLOutputType];
		this.listComprehensionFlagPath = [];
		this.level = -1;
		this.buffer = [];
		this.tokenBuffer = [];
	}

	visitField(fieldNode: FieldNode): boolean | undefined {
		const isConnection = ConnectionSuffixRegex.test(fieldNode.name.value);
		this.level++;
		const token: Token = { type: "property-selector", level: this.level, value: [] };
		this.tokenBuffer.push(token);
		const systemValue = this.tryGetSystemFieldValue(fieldNode);
		if (systemValue) {
			token.value.push(...systemValue.value);
			return;
		}

		const schemaField = (last(this.typePath) as GraphQLObjectType).getFields()[fieldNode.name.value];
		const fieldType = unwrapType(schemaField.type as GraphQLObjectType) as GraphQLObjectType;
		this.fieldNodePath.push(fieldNode);
		this.fieldPath.push(schemaField);
		this.listComprehensionFlagPath.push(null);
		this.typePath.push(fieldType);
		const cypherDirective = this.getCypherDirective();
		const relationshipDirective = this.getRelationshipDirective();
		if (this.level === 0) {
			this.insertTopLevelExpression(fieldNode, fieldType, cypherDirective);
			return;
		}

		if (isScalarType(fieldType) || isEnumType(fieldType)) {
			token.value.push(
				...(cypherDirective
					? [
							fieldNode.alias?.value || fieldNode.name.value,
							":",
							...this.createCypherCodeCallExpression(cypherDirective),
							...(isListType(unwrapNullableType(schemaField.type)) ? [] : ["[0]"]),
					  ]
					: [`.${fieldNode.name.value}`])
			);
			return;
		}

		token.value.push(fieldNode.alias?.value || fieldNode.name.value, ":");

		if (!cypherDirective && !relationshipDirective) {
			if (fieldNode.name.value === "node") {
				token.value.push(this.nodeVariableName);
			} else if (!isConnection) {
				token.value.push("null");
				return true;
			}
			return;
		}

		this.listComprehensionFlagPath[this.listComprehensionFlagPath.length - 1] =
			(relationshipDirective || cypherDirective) && isListType(unwrapNullableType(schemaField.type)) ? "list" : "single";
		if (cypherDirective) {
			this.createCypherBasedListComprehension(cypherDirective);
			return;
		}

		this.createRelationshipBasedComprehension(fieldNode, relationshipDirective!);
	}

	visitEndField(fieldNode: FieldNode): void {
		if (this.level === 0) {
			last(this.tokenBuffer)?.value.push(...this.processOptions(fieldNode.arguments));
		}

		const systemValue = this.tryGetSystemFieldValue(fieldNode);
		if (systemValue) {
			this.level--;
			return;
		}

		const listComprehensionFlag = this.listComprehensionFlagPath.pop();
		if (listComprehensionFlag && this.level > 0) {
			last(this.tokenBuffer)!.value.push(...(listComprehensionFlag === "list" ? ["]"] : ["]", "[0]"]));
		}
		this.fieldNodePath.pop();
		this.fieldPath.pop();
		this.typePath.pop();
		this.level--;
	}

	visitEndSelectionSet(parentNode: ASTNode): void {
		if (parentNode.kind === "FragmentDefinition" || parentNode.kind === "InlineFragment" || this.level === -1) {
			return;
		}

		const [thisLevelFieldTokens, upperLevelFieldTokens] = partition(
			this.tokenBuffer,
			(token) => token.type === "property-selector" && token.level > this.level
		);
		this.tokenBuffer = upperLevelFieldTokens;
		const parentToken = last(upperLevelFieldTokens);
		(parentToken?.value || this.buffer).push(
			"{",
			...insertBetweenArrayItems(
				thisLevelFieldTokens.map((token) => token.value),
				[","]
			).flat(),
			"}"
		);
	}

	visitInlineFragment(inlineFragment: InlineFragmentNode): void {
		if (!inlineFragment.typeCondition) {
			throw new ApolloError("Type condition is not specified");
		}
		this.typePath.push(this.schema.getType(inlineFragment.typeCondition?.name.value) as GraphQLObjectType);
	}

	visitEndInlineFragment(): void {
		this.typePath.pop();
	}

	protected createConditionTreesByField(
		args: ReadonlyArray<ArgumentNode> | Array<ArgumentNode> | undefined,
		fieldType: GraphQLObjectType,
		fieldName: string
	) {
		const whereArg = args?.find((arg) => arg.name.value === "where");
		return whereArg ? this.createConditionTrees(whereArg.value, fieldType, fieldName) : [];
	}

	protected getTargetIfConnectionType(type: GraphQLObjectType) {
		return unwrapType(
			ConnectionSuffixRegex.test(type.name)
				? (unwrapType(type.getFields()["edges"].type) as GraphQLObjectType).getFields()["node"].type
				: type
		) as GraphQLObjectType;
	}

	private insertTopLevelExpression(fieldNode: FieldNode, fieldType: GraphQLObjectType, cypherDirective: DirectiveNode | undefined) {
		const fieldName = `${toCamelCase(fieldType.name)}${this.level}`;
		if (cypherDirective) {
			last(this.tokenBuffer)!.value.push(
				"UNWIND",
				...this.createCypherCodeCallExpression(cypherDirective),
				"as",
				fieldName,
				"RETURN",
				fieldName
			);
			return;
		}

		const searchConditionTrees = this.createConditionTreesByField(fieldNode.arguments, fieldType, fieldNode.name.value);
		last(this.tokenBuffer)!.value.push(
			"MATCH",
			...this.createNodeMatchingExpression(fieldType, searchConditionTrees),
			"RETURN",
			fieldName
		);
	}

	private createRelationshipBasedComprehension(fieldNode: FieldNode, relationshipDirective: DirectiveNode) {
		const isEdges = fieldNode.name.value === "edges";
		const sourceType = this.typePath[this.typePath.length - (isEdges ? 3 : 2)] as GraphQLObjectType;
		const relationshipType = this.typePath[this.typePath.length - (isEdges ? 2 : 1)] as GraphQLObjectType;
		const targetType = this.getTargetIfConnectionType(relationshipType) as GraphQLObjectType;
		const relationshipFieldNode = this.fieldNodePath[this.fieldNodePath.length - (isEdges ? 2 : 1)];
		const searchConditionTrees = this.createConditionTreesByField(
			relationshipFieldNode.arguments,
			relationshipType,
			relationshipFieldNode.name.value
		);
		last(this.tokenBuffer)!.value.push(
			"[",
			`(${toCamelCase(sourceType.name)}${this.getClosestNodeLevel()})`,
			...this.createRelationshipPatternPart(relationshipDirective, fieldNode.name.value, searchConditionTrees, this.level),
			...this.createNodeMatchingExpression(targetType, searchConditionTrees),
			"|",
			isEdges ? `rel_${fieldNode.name.value}${this.level}` : `${toCamelCase(targetType.name)}${this.level}`
		);
	}

	private getClosestNodeLevel() {
		return (
			this.fieldPath.length -
			2 -
			this.fieldPath
				.slice(0, this.fieldPath.length - 1)
				.reverse()
				.findIndex((field) => field.name !== "node" && !ConnectionSuffixRegex.test(field.name))
		);
	}

	private createNodeMatchingExpression(fieldType: GraphQLObjectType, searchConditionTrees: Array<Condition>) {
		return [
			"(",
			`${toCamelCase(fieldType.name)}${this.level}`,
			":",
			fieldType.name,
			...this.createPropertyMatchingPatternPart(searchConditionTrees, true),
			")",
			...this.createWhereCondition(searchConditionTrees, this.level),
		];
	}

	private createCypherBasedListComprehension(cypherDirective: DirectiveNode) {
		const fieldType = unwrapType(last(this.fieldPath)!.type) as GraphQLObjectType;
		last(this.tokenBuffer)!.value.push(
			"[",
			`${toCamelCase(fieldType.name)}${this.level}`,
			"in",
			...this.createCypherCodeCallExpression(cypherDirective),
			"|",
			`${toCamelCase(fieldType.name)}${this.level}`
		);
	}

	private createCypherCodeCallExpression(cypherDirective: DirectiveNode) {
		const statementArgument = cypherDirective.arguments?.find((argument) => argument.name.value === "statement");
		const statement = (statementArgument!.value as StringValueNode).value;
		return [
			"apoc.cypher.runFirstColumn(",
			`"${statement}"`,
			",",
			"{",
			"this",
			":",
			`${toCamelCase((this.typePath[this.typePath.length - 2] as GraphQLObjectType).name)}${this.getClosestNodeLevel()}`,
			",",
			"cypherParams",
			":",
			"$cypherParams",
			"}",
			")",
		];
	}

	private createRelationshipPatternPart(
		relationshipDirective: DirectiveNode,
		fieldName: string,
		searchConditionTrees: Array<Condition>,
		level: number | string,
		omitVariables: boolean = false
	) {
		const relationshipType = relationshipDirective.arguments?.find((argument) => argument.name.value === "type")
			?.value as EnumValueNode;
		const relationshipDirection = relationshipDirective.arguments?.find((argument) => argument.name.value === "direction")
			?.value as StringValueNode;
		const propertyMatchingPatternPart = this.createPropertyMatchingPatternPart(searchConditionTrees, false);

		return [
			relationshipDirection?.value === "OUT" ? "-" : "<-",
			"[",
			...(omitVariables ? [] : [`rel_${fieldName}${level}`]),
			`:${relationshipType?.value}`,
			...propertyMatchingPatternPart,
			"]",
			relationshipDirection?.value === "OUT" ? "->" : "-",
		];
	}

	private canCreateFastExistentialExpression(path: Array<Condition>) {
		const [head, ...rest] = path;
		if (!head) {
			return true;
		}

		return (
			!head.operator &&
			this.canCreateFastExistentialExpression(rest) &&
			(head.nested || []).every(
				(nested) =>
					(!nested.nested?.length || (!nested.isOr && nested.nested?.every((condition) => !condition.operator))) &&
					!nested.operator
			)
		);
	}

	private getDeepFirstSearchPaths(condition: Condition, parentConditions: Array<Condition> = []): Array<Array<Condition>> {
		const nextParentConditions = [...parentConditions, condition];
		const nestedPaths =
			condition.nested
				?.filter((nestedCondition) => !nestedCondition.isRelationship && nestedCondition.nested?.length)
				.flatMap((nestedCondition) => this.getDeepFirstSearchPaths(nestedCondition, nextParentConditions)) || [];
		return nestedPaths.length ? nestedPaths : [nextParentConditions];
	}

	private createExistentialExpressionPatternByPathRecursive(path: Array<Condition>, level: number, omitVariables: boolean, index = 0) {
		const [head, ...rest] = path;
		if (!head) {
			return [];
		}

		if (head.isOr || head.isGroup) {
			return this.createExistentialExpressionPatternByPathRecursive(rest, level, omitVariables, index);
		}

		const relationshipField = head.parentType.getFields()[head.property!];
		const relationship = typeFieldsToDirectivesMap[
			`${head.parentType.name}.${relationshipField.name.replace(ConnectionSuffixRegex, "")}`
		]?.find((directive) => directive.name.value === "relationship") as DirectiveNode;
		const fieldType = unwrapType(relationshipField.type) as GraphQLObjectType;

		return [
			...(index === 0 ? ["(", `${toCamelCase(head.parentType.name)}${level}`, ")"] : []),
			...this.createRelationshipPatternPart(relationship, head.property!, head.nested || [], `${level}_${index}`, omitVariables),
			`(`,
			...(omitVariables ? [] : [`${toCamelCase(fieldType.name)}${level}_${index}`]),
			`:${this.getTargetIfConnectionType(fieldType).name}`,
			...this.createPropertyMatchingPatternPart(head.nested || [], true),
			")",
			...this.createExistentialExpressionPatternByPathRecursive(rest, level, omitVariables, index + 1),
		];
	}

	private createSinglePropertyConditionExpression(condition: Condition, level: string | number): Array<string> {
		const propertyAccessorExpression = `${
			condition.isRelationship ? `rel_${condition.parentPropertyName}` : toCamelCase(condition.parentType.name)
		}${level}.${condition.property}`;
		switch (condition.operator || "EQUALS") {
			case "CONTAINS":
				return [propertyAccessorExpression, "CONTAINS", condition.value];
			case "IN":
				return [propertyAccessorExpression, "IN", condition.value];
			case "NOT_IN":
				return ["NOT", "(", propertyAccessorExpression, "IN", condition.value, ")"];
			case "INCLUDES":
				return [condition.value, "IN", propertyAccessorExpression];
			case "MATCHES":
				return [propertyAccessorExpression, "=~", condition.value];
			case "ENDS_WITH":
				return [propertyAccessorExpression, "ENDS WITH", condition.value];
			case "NOT_ENDS_WITH":
				return ["NOT", "(", propertyAccessorExpression, "ENDS WITH", condition.value, ")"];
			case "NOT_CONTAINS":
				return ["NOT", "(", propertyAccessorExpression, "CONTAINS", condition.value, ")"];
			case "GT":
				return [propertyAccessorExpression, ">", condition.value];
			case "GTE":
				return [propertyAccessorExpression, ">=", condition.value];
			case "LT":
				return [propertyAccessorExpression, "<", condition.value];
			case "LTE":
				return [propertyAccessorExpression, "<=", condition.value];
			case "NOT":
				return [propertyAccessorExpression, "<>", condition.value];
			case "EQUALS":
				return [propertyAccessorExpression, "=", condition.value];
			default:
				throw new ApolloError(`Unknown operator: ${condition.operator}`);
		}
	}

	private createPropertyConditionExpressions(
		condition: Condition,
		level: string | number,
		index: number | undefined,
		includeEquality = false
	): Array<Array<string>> {
		if (condition.isOr) {
			const ORConditions = condition
				.nested!.filter((condition) => !this.isRelationshipCondition(condition))
				.flatMap((nestedCondition) => this.createPropertyConditionExpressions(nestedCondition, level, index, true));
			return ORConditions.length ? [["(", ...insertBetweenArrayItems(ORConditions, ["OR"]).flat(), ")"]] : [];
		}

		if (!condition.isGroup) {
			return condition.operator || includeEquality
				? [this.createSinglePropertyConditionExpression(condition, isEmptyValue(index) ? level : `${level}_${index}`).flat()]
				: [];
		}

		const result = (condition.nested || [])
			.map((condition) => this.createPropertyConditionExpressions(condition, level, index, includeEquality))
			.flat()
			.filter((elements) => elements.length);

		return insertBetweenArrayItems(result, ["AND"]);
	}

	private createExistentialWhereConditions(path: Array<Condition>, level: number) {
		const tuples = path.reduce(
			(a, c) => ({
				index: c.isGroup || c.isOr ? a.index : a.index + 1,
				conditions: [...a.conditions, { condition: c, index: a.index }],
			}),
			{ index: 0, conditions: [] as Array<{ condition: Condition; index: number }> }
		).conditions;
		return insertBetweenArrayItems(
			tuples.flatMap(({ condition, index }) =>
				(condition.nested || []).flatMap((nested) => this.createPropertyConditionExpressions(nested, level, index))
			),
			["AND"]
		);
	}

	private createExistentialExpressionPatternByPathRoot(path: Array<Condition>, level: number): Array<string> {
		const canCreateFastExistentialExpression = this.canCreateFastExistentialExpression(path);
		const patternElements = this.createExistentialExpressionPatternByPathRecursive(path, level, canCreateFastExistentialExpression);
		return canCreateFastExistentialExpression
			? ["exists", "(", ...patternElements, ")"]
			: ["exists", "{", ...patternElements, "WHERE", ...this.createExistentialWhereConditions(path, level).flat(), "}"];
	}

	private isRelationshipCondition = (condition: Condition) =>
		(condition.nested?.length && !condition.isGroup && !condition.isOr) ||
		condition.nested?.some((nested) => this.isRelationshipCondition(nested));

	private createConditionExpressions(path: Array<Condition>, level: number): Array<string> {
		return path.every((condition) => condition.isGroup || condition.isOr || condition.operator || !condition.nested?.length)
			? path.flatMap((condition) => this.createPropertyConditionExpressions(condition, level, undefined)).flat()
			: this.createExistentialExpressionPatternByPathRoot(path, level);
	}

	private createWhereCondition(conditionTrees: Array<Condition>, level: number): Array<string> {
		const relationshipConditions = conditionTrees.filter((condition) => this.isRelationshipCondition(condition));
		const allPaths = relationshipConditions.flatMap((condition) => this.getDeepFirstSearchPaths(condition));
		const [ORPaths, ANDPaths] = partition(allPaths, (path) => path.some((condition) => condition.isOr));
		const elements = insertBetweenArrayItems(
			[
				insertBetweenArrayItems(
					ORPaths.map((path) => this.createConditionExpressions(path, level)),
					["OR"]
				).flat(),
			]
				.concat(ANDPaths.map((path) => this.createConditionExpressions(path, level)))
				.concat(conditionTrees.flatMap((condition) => this.createPropertyConditionExpressions(condition, level, undefined))),
			["AND"]
		).flat();
		return elements.length ? ["WHERE", ...elements] : [];
	}

	private createConditionsByObjectFieldNode(
		field: ObjectFieldNode,
		parentType: GraphQLObjectType,
		parentPropertyName: string | undefined
	): Array<Condition> {
		if (parentPropertyName && ConnectionSuffixRegex.test(parentPropertyName)) {
			if (field.name.value === "node") {
				return this.createConditionTrees(field.value, this.getTargetIfConnectionType(parentType), parentPropertyName);
			}

			if (field.name.value === "edge") {
				return this.createConditionTrees(
					field.value,
					unwrapType(parentType.getFields()["edges"].type as GraphQLObjectType) as GraphQLObjectType,
					parentPropertyName
				);
			}
		}

		if (field.name.value === "OR") {
			return [
				{
					parentType,
					parentPropertyName,
					isOr: true,
					nested: (field.value as ListValueNode).values.map(
						(value) =>
							({
								isGroup: true,
								nested: this.createConditionTrees(value, parentType, parentPropertyName),
							} as Condition)
					),
				},
			];
		}

		if (field.name.value === "AND") {
			return field.value.kind === "ListValue"
				? field.value.values.flatMap((value) => this.createConditionTrees(value, parentType, parentPropertyName))
				: this.createConditionTrees(field.value, parentType, parentPropertyName);
		}

		const property = field.name.value.split("_")[0];
		const fieldType = unwrapType(parentType.getFields()[property].type);

		return [
			{
				parentType: this.getTargetIfConnectionType(parentType),
				parentPropertyName,
				isRelationship: RelationshipSuffixRegex.test(parentType.name),
				property,
				operator: field.name.value.split("_").slice(1).join("_") as OperatorType,
				value: isObjectType(fieldType) ? undefined : this.readValue(fieldType, field.value),
				nested: isObjectType(fieldType) ? this.createConditionTrees(field.value, fieldType, property) : undefined,
			},
		];
	}

	private readValue(fieldType: GraphQLOutputType, value: ValueNode): string | null | number | boolean | Array<any> {
		if (value.kind === "BooleanValue" || value.kind === "FloatValue" || value.kind === "IntValue") {
			return value.value;
		}

		if (value.kind === "StringValue" || value.kind === "EnumValue") {
			return `'${value.value}'`;
		}

		if (isObjectType(fieldType)) {
			return null;
		}

		if (value.kind === "ListValue") {
			return [
				"[",
				...insertBetweenArrayItems(
					value.values.map((listItem) => this.readValue(fieldType, listItem)),
					","
				),
				"]",
			];
		}

		if (value.kind === "Variable") {
			return `$${value.name.value}`;
		}

		return null;
	}

	private createConditionTrees(
		valueNode: ValueNode,
		parentType: GraphQLObjectType,
		parentPropertyName: string | undefined
	): Array<Condition> {
		if (valueNode.kind === "ObjectValue") {
			return valueNode.fields.flatMap((field) => this.createConditionsByObjectFieldNode(field, parentType, parentPropertyName));
		}

		if (valueNode.kind === "ListValue") {
			return valueNode.values.flatMap((listItem) => this.createConditionTrees(listItem, parentType, parentPropertyName));
		}

		if (valueNode.kind === "Variable") {
			return this.createConditionTreesByObject(this.variables[valueNode.name.value], parentType, parentPropertyName);
		}

		return [];
	}

	private createPropertyMatchingPatternPart(conditionTrees: Array<Condition>, isNode: boolean) {
		const items = conditionTrees
			.filter(
				(condition) =>
					isNode === !condition.isRelationship &&
					!condition.nested?.length &&
					!Array.isArray(condition.value) &&
					!condition.operator
			)
			.map((condition) => `${condition.property}: ${condition.value}`);
		return items.length ? [`{${items.join(", ")}}`] : [];
	}

	private processOptions(args: ReadonlyArray<ArgumentNode> | undefined): Array<string> {
		const options: OptionsType = this.readOptions(args?.find((arg) => arg.name.value === "options")?.value);
		const fieldType = last(this.typePath)! as GraphQLObjectType;
		const sortItems = castToArray(options.sort)
			.flatMap((obj) => Object.entries(obj))
			.map(([key, value]) => `${`${toCamelCase(fieldType.name)}${this.level}`}.${key} ${value}`);
		return [
			...(sortItems.length ? ["ORDER BY", ...insertBetweenArrayItems(sortItems, ",")] : []),
			...(!isEmptyValue(options.offset) ? ["SKIP", options.offset!.toString()] : []),
			...(options.limit ? ["LIMIT", options.limit.toString()] : []),
		];
	}

	private readOptions(node: ValueNode | undefined) {
		if (!node) {
			return {};
		}

		if (node.kind === "Variable") {
			return this.variables[node.name.value];
		}

		if (node.kind === "ListValue") {
			return node.values.map((value) => this.readOptions(value));
		}

		if (node.kind === "ObjectValue") {
			return node.fields.reduce((a, field) => ({ ...a, [field.name.value]: this.readOptions(field.value) }), {});
		}

		if (node.kind === "StringValue") {
			return `'${node.value}'`;
		}

		return node.kind === "NullValue" ? null : node.value;
	}

	private createConditionTreesByObject(
		obj: any,
		parentType: GraphQLObjectType,
		parentPropertyName: string | undefined
	): Array<Condition> {
		if (Array.isArray(obj)) {
			return obj.flatMap((item) => this.createConditionTreesByObject(item, parentType, parentPropertyName));
		}

		return Object.entries(obj).flatMap(([name, value]) =>
			this.createConditionTreesByObjectField(name, value, parentType, parentPropertyName)
		);
	}

	private createConditionTreesByObjectField(
		field: string,
		value: any,
		parentType: GraphQLObjectType,
		parentPropertyName: string | undefined
	): Array<Condition> {
		if (parentPropertyName && ConnectionSuffixRegex.test(parentPropertyName)) {
			if (field === "node") {
				return this.createConditionTreesByObject(value, this.getTargetIfConnectionType(parentType), parentPropertyName);
			}

			if (field === "edge") {
				return this.createConditionTreesByObject(
					value,
					unwrapType(parentType.getFields()["edges"].type as GraphQLObjectType) as GraphQLObjectType,
					parentPropertyName
				);
			}
		}

		if (field === "OR") {
			return [
				{
					parentType: this.getTargetIfConnectionType(parentType),
					parentPropertyName,
					isOr: true,
					nested: (value as Array<any>).map(
						(source) =>
							({
								isGroup: true,
								nested: this.createConditionTreesByObject(source, parentType, parentPropertyName),
							} as Condition)
					),
				},
			];
		}

		if (Array.isArray(value) && (!value.length || typeof value[0] === "object")) {
			return value.flatMap((item) => this.createConditionTreesByObject(item, parentType, parentPropertyName));
		}

		const property = field.split("_")[0];
		const fieldType = unwrapType(parentType.getFields()[property].type);

		return [
			{
				parentType: this.getTargetIfConnectionType(parentType),
				property,
				parentPropertyName,
				isRelationship: RelationshipSuffixRegex.test(parentType.name),
				operator: field.split("_").slice(1).join("_") as OperatorType,
				value: isObjectType(fieldType) ? null : this.mapConditionValue(value),
				nested: isObjectType(fieldType) ? this.createConditionTreesByObject(value, fieldType, property) : undefined,
			} as Condition,
		];
	}

	private mapConditionValue = (value: any) => {
		if (!value) {
			return value;
		}

		if (typeof value === "object" && value.year && typeof value.month === "number") {
			return format(new Date(value.year, value.month - 1, value.day), "yyyy-MM-dd");
		}

		if (Array.isArray(value)) {
			return [
				"[",
				...insertBetweenArrayItems(
					value.map((item) => (typeof item === "string" ? `'${item}'` : item)),
					","
				),
				"]",
			];
		}

		if (typeof value === "string") {
			return `'${value}'`;
		}

		return value;
	};

	private tryGetSystemFieldValue(field: FieldNode) {
		if (field.name.value === "__typename") {
			return {
				value: [field.name.value, ":", last(this.typePath) ? `'${(last(this.typePath) as GraphQLObjectType).name}'` : "null"],
			};
		}
	}

	private getCypherDirective() {
		const typeFieldKey = `${(this.typePath[this.typePath.length - 2] as GraphQLObjectType).name}.${last(this.fieldPath)!.name}`;
		return typeFieldsToDirectivesMap[typeFieldKey]?.find((directive) => directive.name.value === "cypher");
	}

	private getRelationshipDirective() {
		const fieldName = last(this.fieldPath)!.name;
		if (ConnectionSuffixRegex.test(fieldName)) {
			return;
		}

		const shiftToRelationshipField = fieldName === "edges" ? 1 : 0;
		const typeFieldKey = `${
			(this.typePath[this.typePath.length - 2 - shiftToRelationshipField] as GraphQLObjectType).name
		}.${this.fieldPath[this.fieldPath.length - 1 - shiftToRelationshipField]?.name.replace(ConnectionSuffixRegex, "")}`;
		return typeFieldsToDirectivesMap[typeFieldKey]?.find((directive) => directive.name.value === "relationship");
	}

	private get nodeVariableName() {
		return `${toCamelCase(this.getTargetIfConnectionType(this.typePath[this.typePath.length - 3] as GraphQLObjectType).name)}${
			this.level - 1
		}`;
	}
}
