import { byAsc, byDesc, sortByComparisons } from "@lyfegen-platform/utils";
import {
	ArgumentNode,
	FieldNode,
	GraphQLResolveInfo,
	ListValueNode,
	ObjectValueNode,
	SelectionNode,
	StringValueNode,
	ValueNode,
} from "graphql";
import { reduceWhile } from "../../shared/reduce-until";
import { ConnectionSuffixRegex } from "./models";

export class GraphQlExtensionService {
	constructor(private readonly info: GraphQLResolveInfo) {}

	applyExtensionsRoot(data: any) {
		return this.applyExtensions(data, this.info.fieldNodes.find((field) => field.name.value === this.info.fieldName)!);
	}

	private applyExtensions(data: any, fieldNode: FieldNode, parentFieldNode?: FieldNode) {
		if (!data) {
			return data;
		}

		const argumentsContainer =
			fieldNode.name.value === "edges" && parentFieldNode && ConnectionSuffixRegex.test(parentFieldNode.name.value)
				? parentFieldNode
				: fieldNode;

		if (Array.isArray(data) && argumentsContainer.arguments) {
			const sortArgument = argumentsContainer.arguments?.find((arg) => arg.name.value === "sort");
			const limitArgument = argumentsContainer.arguments?.find((arg) => arg.name.value === "first");
			const sortedOrDefault: Array<any> = sortArgument
				? (data as Array<any>).sort(sortByComparisons(...this.createComparisons(sortArgument)))
				: data;
			const limitedOrDefault = limitArgument ? sortedOrDefault.slice(0, +this.resolveValue(limitArgument.value)) : sortedOrDefault;
			return limitedOrDefault.map((item) => this.applyExtensions(item, fieldNode, parentFieldNode));
		}

		if (Array.isArray(data)) {
			return data.map((item) => this.applyExtensions(item, fieldNode, parentFieldNode));
		}

		const selectionSetFields = fieldNode.selectionSet && this.flattenSelectionSet(fieldNode.selectionSet?.selections);
		return (
			selectionSetFields?.reduce(
				(a, childFieldNode) => ({
					...a,
					[childFieldNode.name.value]: this.applyExtensions(data[childFieldNode.name.value], childFieldNode, fieldNode),
				}),
				data
			) || data
		);
	}

	resolveValue(value: ValueNode) {
		return value.kind === "Variable" ? this.info.variableValues[value.name.value] : (value as StringValueNode).value;
	}

	flattenSelectionSet(selections: Array<SelectionNode> | Readonly<Array<SelectionNode>>): Array<FieldNode> {
		return (
			selections.flatMap((selection) => {
				if (selection.kind === "FragmentSpread") {
					return this.flattenSelectionSet(this.info.fragments[selection.name.value]?.selectionSet.selections || []);
				}

				if (selection.kind === "InlineFragment") {
					return this.flattenSelectionSet(selection.selectionSet?.selections || []);
				}

				return [selection];
			}) || []
		);
	}

	createComparisons(sortArgument: ArgumentNode) {
		const values =
			sortArgument.value.kind === "ObjectValue"
				? [sortArgument.value]
				: ((sortArgument.value as ListValueNode).values as Array<ObjectValueNode>);
		const sortFields = values.flatMap((value) =>
			value.fields.map((field) =>
				field.value.kind === "ObjectValue"
					? {
							field: `${field.name.value}.${field.value.fields[0].name.value}`,
							order: (field.value.fields[0].value as StringValueNode).value.toUpperCase(),
					  }
					: {
							field: field.name.value,
							order: (field.value as StringValueNode).value.toUpperCase(),
					  }
			)
		);

		return sortFields.map(({ field, order }) =>
			order === "DESC" ? byDesc(this.createAccessor(field)) : byAsc(this.createAccessor(field))
		);
	}

	private createAccessor = (path: string) => {
		const fieldNames = path.split(".");
		return (data: any) =>
			reduceWhile(
				fieldNames,
				(a, fieldName) => a[fieldName],
				data,
				(_, a) => !!a
			);
	};
}
