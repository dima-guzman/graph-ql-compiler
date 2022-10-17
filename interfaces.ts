import { ASTNode, FieldNode, InlineFragmentNode, OperationDefinitionNode, SelectionSetNode } from "graphql";

export interface IGraphQlQueryVisitor {
	visitOperation(operation: OperationDefinitionNode): void;
	visitField(field: FieldNode): boolean | undefined;
	visitEndField?(field: FieldNode): void;
	visitSelectionSet?(selectionSet: SelectionSetNode): void;
	visitEndSelectionSet?(parentNode: ASTNode): void;
	visitInlineFragment?(inlineFragment: InlineFragmentNode): void;
	visitEndInlineFragment?(inlineFragment: InlineFragmentNode): void;
}
