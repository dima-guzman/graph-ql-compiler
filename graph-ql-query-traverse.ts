import { ASTNode, FieldNode, FragmentDefinitionNode, GraphQLResolveInfo, InlineFragmentNode, OperationDefinitionNode } from "graphql";
import { IGraphQlQueryVisitor } from "./interfaces";

export class GraphQlQueryTraverse {
	constructor(private readonly info: GraphQLResolveInfo, private readonly visitor: IGraphQlQueryVisitor) {}

	walk(node: ASTNode) {
		switch (node.kind) {
			case "OperationDefinition":
				this.visitor.visitOperation(node);
				this.walkSelectionSet(node);
				return;
			case "Field":
				{
					const isHandled = this.visitor.visitField(node);
					if (!isHandled) {
						this.walkSelectionSet(node);
					}
					this.visitor.visitEndField?.(node);
				}
				return;
			case "InlineFragment":
				this.visitor.visitInlineFragment?.(node);
				this.walkSelectionSet(node);
				this.visitor.visitEndInlineFragment?.(node);
				return;
			case "FragmentSpread":
				this.walkSelectionSet(this.info.fragments[node.name.value]);
				return;
		}
	}

	private walkSelectionSet(node: FieldNode | OperationDefinitionNode | FragmentDefinitionNode | InlineFragmentNode) {
		if (node.selectionSet) {
			this.visitor.visitSelectionSet?.(node.selectionSet);
			node.selectionSet.selections
				.filter(
					(selection) =>
						node.kind !== "OperationDefinition" || (selection.kind === "Field" && selection.name.value === this.info.fieldName)
				)
				.forEach((selection) => this.walk(selection));
			this.visitor.visitEndSelectionSet?.(node);
		}
	}
}
