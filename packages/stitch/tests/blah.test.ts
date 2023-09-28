import {
  graphql,
  GraphQLNamedOutputType,
  GraphQLResolveInfo,
  isOutputType,
  Kind,
  OperationTypeNode,
  print,
  printSchema,
} from 'graphql/index';
import { GraphQLSchema } from 'graphql/type/schema';
import { delegateToSchema } from '@graphql-tools/delegate';
import { addMocksToSchema } from '@graphql-tools/mock';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { forwardArgsToSelectionSet, stitchSchemas } from '@graphql-tools/stitch';
import { parseSelectionSet } from '@graphql-tools/utils';

const getFieldNode = (info: GraphQLResolveInfo) => {
  if (info.fieldNodes.length !== 1) {
    throw new Error('fieldNodes with length != 1 is not supported');
  }

  return info.fieldNodes[0];
};

const getOutputType = (schema: GraphQLSchema, name: string): GraphQLNamedOutputType => {
  const type = schema.getType(name);
  if (!type) {
    throw new Error(`Could not get type ${name} from schema`);
  }
  if (!isOutputType(type)) {
    throw new Error(`${name} is not an output type`);
  }

  return type;
};

describe('Blah', () => {
  let aggSchema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Query {
        ccp: CcpQuery
      }

      type CcpQuery {
        ccpEntitlement(id: ID!): CcpEntitlement
        ccpProduct(id: ID!): CcpProduct
      }

      type CcpEntitlement {
        id: ID!
        offeringId: ID
      }

      type CcpProduct {
        id: ID!
        name: String
      }
    `,
  });

  let bbfSchema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Query {
        ccpOffering(id: ID!): CcpOffering
      }

      type CcpOffering {
        id: ID!
        productId: ID
      }
    `,
  });

  let stitchedSchema: GraphQLSchema;

  let aggResolvers;

  let bbfResolvers: any;

  afterEach(() => {
    jest.resetAllMocks();
  });

  beforeEach(() => {
    aggResolvers = {
      CcpQuery: {
        ccpEntitlement: async (_source: any, args: { id: string }) => {
          return {
            id: args.id,
            offeringId: args.id,
          };
        },
        ccpProduct: async (_source: any, args: { id: string }) => {
          return {
            id: args.id,
            name: args.id,
          };
        },
      },
    };

    bbfResolvers = {
      Query: {
        ccpOffering: async (_source: any, args: { id: string }) => {
          return {
            id: args.id,
            productId: args.id,
          };
        },
      },
    };

    aggSchema = addMocksToSchema({
      schema: aggSchema,
      resolvers: aggResolvers,
    });
    bbfSchema = addMocksToSchema({
      schema: bbfSchema,
      resolvers: bbfResolvers,
    });

    stitchedSchema = stitchSchemas({
      subschemas: [{ schema: aggSchema }, { schema: bbfSchema }],
      resolverValidationOptions: { requireResolversForResolveType: 'ignore' },
      typeDefs: /* GraphQL */ `
        extend type CcpEntitlement {
          offering: CcpOffering
        }

        extend type CcpOffering {
          product: CcpProduct
        }
      `,
      resolvers: {
        CcpEntitlement: {
          offering: {
            selectionSet: forwardArgsToSelectionSet('{ offeringId }'),
            resolve: (parent, _args, context, info) => {
              return delegateToSchema({
                schema: bbfSchema,
                operation: OperationTypeNode.QUERY,
                fieldName: 'ccpOffering',
                args: { id: parent.offeringId },
                context,
                info,
              });
            },
          },
        },
        CcpOffering: {
          product: {
            selectionSet: forwardArgsToSelectionSet('{ productId }'),
            resolve: async (parent, _args, context, info) => {
              const fieldNode = getFieldNode(info);
              const result = await delegateToSchema({
                schema: aggSchema,
                operation: OperationTypeNode.QUERY,
                fieldName: 'ccp',
                returnType: getOutputType(aggSchema, 'CcpQuery'),
                selectionSet: parseSelectionSet(
                  `{ ccpProduct(id: "${parent.productId}") ${print(fieldNode.selectionSet!)} }`,
                ),
                context,
                info,
              });
              return result.ccpProduct;
            },
          },
        },
      },
    });
  });

  it('creates expected schema', () => {
    expect(printSchema(stitchedSchema)).toMatchSnapshot();
  });

  it('executes separate query on AGG', async () => {
    const query = /* GraphQL */ `
      query {
        ccp {
          ccpEntitlement(id: "abc") {
            id
            offeringId
          }
        }
      }
    `;

    const result = await graphql({
      schema: stitchedSchema,
      source: query,
    });
    expect(result.errors).toBe(undefined);
    expect(result.data).toEqual({
      ccp: {
        ccpEntitlement: {
          id: 'abc',
          offeringId: 'abc',
        },
      },
    });
  });

  it('executes separate query on BBF', async () => {
    const query = /* GraphQL */ `
      query {
        ccpOffering(id: "abc") {
          id
          productId
        }
      }
    `;

    const result = await graphql({
      schema: stitchedSchema,
      source: query,
    });
    expect(result.errors).toBe(undefined);
    expect(result.data).toEqual({
      ccpOffering: {
        id: 'abc',
        productId: 'abc',
      },
    });
  });

  it('stitches from AGG -> BBF', async () => {
    const query = /* GraphQL */ `
      query {
        ccp {
          ccpEntitlement(id: "abc") {
            id
            offering {
              id
              productId
            }
          }
        }
      }
    `;

    const result = await graphql({
      schema: stitchedSchema,
      source: query,
    });
    expect(result.errors).toBe(undefined);
    expect(result.data).toEqual({
      ccp: {
        ccpEntitlement: {
          id: 'abc',
          offering: {
            id: 'abc',
            productId: 'abc',
          },
        },
      },
    });
  });

  it('stitches from BBF -> AGG', async () => {
    const query = /* GraphQL */ `
      query {
        ccpOffering(id: "abc") {
          id
          product {
            id
            name
          }
        }
      }
    `;

    const result = await graphql({
      schema: stitchedSchema,
      source: query,
    });
    expect(result.errors).toBe(undefined);
    expect(result.data).toEqual({
      ccpOffering: {
        id: 'abc',
        product: {
          id: 'abc',
          name: 'abc',
        },
      },
    });
  });

  it('stitches from AGG -> BBF -> AGG', async () => {
    const query = /* GraphQL */ `
      query {
        ccp {
          ccpEntitlement(id: "abc") {
            id
            offering {
              id
              product {
                id
              }
            }
          }
        }
      }
    `;

    const result = await graphql({
      schema: stitchedSchema,
      source: query,
    });
    expect(result.errors).toBe(undefined);
    expect(result.data).toEqual({
      ccp: {
        ccpEntitlement: {
          id: 'abc',
          offering: {
            id: 'abc',
            product: {
              id: 'abc',
            },
          },
        },
      },
    });
  });
});
