import { FieldNode, FragmentDefinitionNode, GraphQLResolveInfo, OperationDefinitionNode } from "graphql";
import gql from "graphql-tag";
import { schema } from "../../schema";
import { runInTestTransaction } from "../../shared/run-in-test-transaction";
import { graphQlDbReader } from "./graph-ql-db-reader";
import { GraphQlQueryCompiler } from "./graph-ql-query-compiler";
import { GraphQlQueryTraverse } from "./graph-ql-query-traverse";

const testSeeding = `
	CREATE (agreement1:Agreement:BaseAgreement {
		id: "AG-1",
		name: "Agreement 1",
		isDeleted: false,
		status: "RUNNING_TEST",
		allowedForms: ["FT-1"],
		version: 1
	})
	CREATE (agreement2:Agreement:BaseAgreement {
		id: "AG-2",
		name: "Agreement 2",
		isDeleted: false,
		status: "RUNNING_TEST",
		allowedForms: ["FT-1"],
		version: 1
	})
	CREATE (org1:Organization {
		id: "ORG-1",
		name: "Lads"
	})
	CREATE (org2:Organization {
		id: "ORG-2",
		name: "Devs"
	})
	CREATE (formType:FlexEntityType {
		id: "FT-1",
		containerType: "FORM"
	})
	CREATE (exFactoryPrice:ExFactoryPrice {Price: 50, ValidFromDate: '2020-02-01'})
		<-[:HAS]-(treatment:Treatment {Name: "Treatment 1", Code: "007"})
		<-[:REGULATES]-(preparation:Preparation {DescriptionDe: "Preparation 1"})
		-[:BASED_ON]->(generic:Generic {Name: "Generic1"})
	CREATE (agreement1)-[:HAS_PRICED {price: 100}]->(treatment)
	CREATE (tag:AgreementTag {name: "VERY CUSTOM"})
	CREATE (agreement1)-[:HAS_PARTNER {role: 'BUYER_TEST', isApprovalRequired: false}]->(org1)
	CREATE (agreement1)-[:HAS_PARTNER {role: 'SELLER_TEST', isApprovalRequired: true}]->(org2)
	CREATE (agreement2)-[:HAS_PARTNER {role: 'BUYER_TEST', isApprovalRequired: true}]->(org2)
	CREATE (agreement2)-[:HAS_PARTNER {role: 'SELLER_TEST', isApprovalRequired: true}]->(org1)
	CREATE (agreement2)-[:HAS_INITIAL_VERSION]->(agreement1)
`;

test("Search by relationship properties on edge succeeds for embedded conditions", async () => {
	const query = gql`
		query GetMyAgreements {
			baseAgreements(
				where: { status: RUNNING_TEST, counterpartiesConnection: { edge: { role: BUYER_TEST, role_IN: [BUYER_TEST, BUYER_FEST] } } }
			) {
				id
				name
				counterpartiesConnection {
					edges {
						role
						isApprovalRequired
						node {
							id
							name
						}
					}
				}
			}
		}
	`;

	await runInTestTransaction(async (transaction) => {
		await transaction.run(testSeeding);
		const response = await graphQlDbReader(transaction, query, schema, {});

		expect(response.length).toBe(2);
	});
});

test("Search by relationship properties on both edge and node succeeds for embedded conditions", async () => {
	const query = gql`
		query GetMyAgreements {
			baseAgreements(
				where: { status: RUNNING_TEST, counterpartiesConnection: { edge: { role: BUYER_TEST }, node: { name: "Lads" } } }
			) {
				id
				name
				counterpartiesConnection {
					edges {
						role
						isApprovalRequired
						node {
							id
							name
						}
					}
				}
			}
		}
	`;

	await runInTestTransaction(async (transaction) => {
		await transaction.run(testSeeding);
		const response = await graphQlDbReader(transaction, query, schema, {});

		expect(response.length).toBe(1);
	});
});

test("Sorting DESC succeeded", async () => {
	const query = gql`
		query GetMyAgreements {
			baseAgreements(where: { status: RUNNING_TEST }, options: { sort: [{ name: DESC }] }) {
				id
				name
				counterpartiesConnection {
					edges {
						role
						isApprovalRequired
						node {
							id
							name
						}
					}
				}
			}
		}
	`;

	await runInTestTransaction(async (transaction) => {
		await transaction.run(testSeeding);
		const response = await graphQlDbReader(transaction, query, schema, {});

		expect(response.map((r) => r.id)).toEqual(["AG-2", "AG-1"]);
		expect(response.map((r) => r.name)).toEqual(["Agreement 2", "Agreement 1"]);
	});
});

test("Search by relationship properties on both edge and node succeeds for variable conditions", async () => {
	const query = gql`
		query GetMyAgreements {
			baseAgreements(where: $where) {
				id
				name
				counterpartiesConnection {
					edges {
						role
						isApprovalRequired
						node {
							id
							name
						}
					}
				}
			}
		}
	`;

	await runInTestTransaction(async (transaction) => {
		await transaction.run(testSeeding);

		const response = await graphQlDbReader(transaction, query, schema, {
			where: { status: "RUNNING_TEST", counterpartiesConnection: { edge: { role: "BUYER_TEST" }, node: { name: "Lads" } } },
		});

		expect(response.length).toBe(1);

		const response2 = await graphQlDbReader(transaction, query, schema, {
			where: { status: "RUNNING_TEST", counterpartiesConnection: { edge: { role: "BUYER_TEST" } } },
		});

		expect(response2.length).toBe(2);
	});
});

test("Offset and limit application succeeded", async () => {
	const query = gql`
		query GetMyAgreements {
			baseAgreements(where: { status: "RUNNING_TEST" }, options: $options) {
				id
				name
				counterpartiesConnection {
					edges {
						role
						isApprovalRequired
						node {
							id
							name
						}
					}
				}
			}
		}
	`;

	await runInTestTransaction(async (transaction) => {
		await transaction.run(testSeeding);

		const response0 = await graphQlDbReader(transaction, query, schema, {
			options: { offset: 0, limit: 2 },
		});

		expect(response0.length).toBe(2);

		const response1 = await graphQlDbReader(transaction, query, schema, {
			options: { offset: 0, limit: 1 },
		});

		expect(response1.length).toBe(1);

		const response2 = await graphQlDbReader(transaction, query, schema, {
			options: { offset: 2, limit: 1 },
		});

		expect(response2.length).toBe(0);
	});
});

test("Search condition applied", async () => {
	const query = gql`
		query GetMyAgreements {
			baseAgreements(where: { status: "RUNNING_TEST" }, options: { sort: [{ name: DESC }] }) {
				id
				name
				counterpartiesConnection(where: { node: { name_IN: ["Lads", "Guys"] } }) {
					edges {
						role
						isApprovalRequired
						node {
							id
							name
						}
					}
				}
			}
		}
	`;

	await runInTestTransaction(async (transaction) => {
		await transaction.run(testSeeding);

		const response0 = await graphQlDbReader(transaction, query, schema);
		expect(response0[0].counterpartiesConnection.edges.length).toBe(1);
		expect(response0[1].counterpartiesConnection.edges.length).toBe(1);
		expect(response0[0].counterpartiesConnection.edges[0].node.name).toBe("Lads");
		expect(response0[1].counterpartiesConnection.edges[0].node.name).toBe("Lads");
		expect(response0[0].counterpartiesConnection.edges[0].role).toBe("SELLER_TEST");
		expect(response0[1].counterpartiesConnection.edges[0].role).toBe("BUYER_TEST");
	});
});

test("Navigation property access succeeded", async () => {
	const query = gql`
		query GetMyAgreements {
			baseAgreements(
				where: { status: "RUNNING_TEST", counterparties: { name_IN: ["Lads", "Guys"] } }
				options: { sort: [{ name: DESC }] }
			) {
				id
				name
				counterparties(where: { name_IN: ["Lads", "Guys"] }) {
					id
					name
				}
			}
		}
	`;

	await runInTestTransaction(async (transaction) => {
		await transaction.run(testSeeding);

		const response0 = await graphQlDbReader(transaction, query, schema);
		expect(response0[0].counterparties.length).toBe(1);
		expect(response0[1].counterparties.length).toBe(1);
		expect(response0[0].counterparties[0].name).toBe("Lads");
		expect(response0[1].counterparties[0].name).toBe("Lads");
	});
});

test("Query with fragments succeeded", async () => {
	const query = gql`
		fragment FieldsFragment on BaseAgreement {
			id
			name
			counterparties(where: { name_IN: ["Lads", "Guys"] }) {
				id
				name
			}
		}

		query GetMyAgreements {
			baseAgreements(where: { status: "RUNNING_TEST" }, options: { sort: [{ name: DESC }] }) {
				...FieldsFragment
			}
		}
	`;

	await runInTestTransaction(async (transaction) => {
		await transaction.run(testSeeding);

		const response0 = await graphQlDbReader(transaction, query, schema);
		expect(response0[0].counterparties.length).toBe(1);
		expect(response0[1].counterparties.length).toBe(1);
		expect(response0[0].counterparties[0].name).toBe("Lads");
		expect(response0[1].counterparties[0].name).toBe("Lads");
	});
});

test("Applies filter tree", async () => {
	const query = gql`
		query GetMyAgreements {
			baseAgreements(
				where: {
					status: "RUNNING_TEST"
					AND: { version_GTE: 0, version_LTE: 10, version_IN: [1, 2, 3], OR: [{ version: 1 }, { version: 2 }, { version: 3 }] }
				}
				options: { sort: [{ name: DESC }] }
			) {
				id
				name
			}
		}
	`;

	await runInTestTransaction(async (transaction) => {
		await transaction.run(testSeeding);

		const response0 = await graphQlDbReader(transaction, query, schema);
		expect(response0.length).toBe(2);
	});
});

test("Uses proper variable names for query objects", async () => {
	const query = gql`
		query GetMyAgreements {
			baseAgreements {
				treatmentPricesConnection {
					edges {
						node {
							Code
							GTIN
							UDI
							PharmaCode
							SwissmedicNo8
							Name
							LOT
							REF
							canBeMain
							activeIngredientQuantity
							uoMType
							regulatedBy {
								id
								brand {
									Name
								}
								generic {
									Name
								}
								BrandName
								GenericName
								DescriptionDe
							}
							exFactoryPrices {
								Price
								ValidFromDate
							}
						}
						price
						basePriceType
					}
				}
				treatmentPrices {
					Code
					GTIN
					UDI
					PharmaCode
					SwissmedicNo8
					Name
					LOT
					REF
					canBeMain
					activeIngredientQuantity
					uoMType
					regulatedBy {
						id
						brand {
							Name
						}
						generic {
							Name
						}
						BrandName
						GenericName
						DescriptionDe
					}
					exFactoryPrices {
						Price
						ValidFromDate
					}
				}
			}
		}
	`;

	await runInTestTransaction(async (transaction) => {
		await transaction.run(testSeeding);

		const compiler = new GraphQlQueryCompiler(schema, {});
		const fragments = query.definitions
			.filter((definition) => definition.kind === "FragmentDefinition")
			.reduce(
				(a, c) => ({
					...a,
					[(c as FragmentDefinitionNode).name.value]: c,
				}),
				{}
			);
		const operation = query.definitions.find((definition) => definition.kind === "OperationDefinition") as OperationDefinitionNode;
		const traverse = new GraphQlQueryTraverse(
			{
				fieldName: (operation.selectionSet.selections[0] as FieldNode).name.value,
				operation,
				fragments,
			} as GraphQLResolveInfo,
			compiler
		);
		traverse.walk(operation);
		const cypher = compiler.compile();
		console.info(cypher);
		expect(cypher.includes("treatment3")).toBeFalsy();
		expect(cypher.includes("preparation3")).toBeFalsy();
	});
});
