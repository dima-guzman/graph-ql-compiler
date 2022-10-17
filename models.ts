import { GraphQLObjectType } from "graphql";
import { OperatorType } from "../agreement/models";

export interface Condition {
	parentType: GraphQLObjectType;
	parentPropertyName?: string;
	property?: string;
	operator?: OperatorType;
	isOr?: boolean;
	isGroup?: boolean;
	isRelationship?: boolean;
	value?: any;
	nested?: Array<Condition>;
}

export type OptionsType = { limit?: number; offset?: number; sort?: Array<any> | any };

export const ConnectionSuffixRegex = /Connection$/;

export const RelationshipSuffixRegex = /Relationship$/;

export type Token = {
	type: "property-selector";
	value: Array<string>;
	level: number;
};
