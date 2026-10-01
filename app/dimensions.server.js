import {
  DIMENSION_NAMESPACE,
  dimensionNamespace,
  metafieldDimension,
} from './campaigns';
import {
  CAMPAIGN_TYPE,
  DEFINITION_CREATE,
  DEFINITION_QUERY,
  DEFINITION_UPDATE,
  dimensionProbeQuery,
} from './campaign-queries.server';
import {ensureDefinition, transportErrors} from './campaigns.server';

// [START campaign-dashboard.metafield-dimension-read]
const DIMENSIONS = {
  // A reference to the campaign entry. Analytics groups by any field on the entry,
  // and the merchant turns that on for the Campaign type in the admin.
  product: {
    owner: 'products',
    ownerType: 'PRODUCT',
    key: 'campaign',
    name: 'Campaign',
    description: 'The campaign that promoted this product.',
    adminAccess: 'MERCHANT_READ',
    reference: true,
    field: 'campaign_id',
    // The report this blocks, and the section `id` the list links to.
    report: 'Promoted product sales',
    anchor: 'promoted',
  },
  customer: {
    owner: 'customers',
    ownerType: 'CUSTOMER',
    key: 'tier',
    name: 'Campaign tier',
    description: 'The campaign segment this customer was last in.',
    adminAccess: 'MERCHANT_READ',
    report: 'Segment sales',
    anchor: 'audience-sales',
  },
  order: {
    owner: 'orders',
    ownerType: 'ORDER',
    key: 'campaign_touch',
    name: 'Campaign touch',
    description: 'The campaign send or event this order followed.',
    adminAccess: 'MERCHANT_READ',
    report: 'Order attribution',
    anchor: 'touch-sales',
  },
};

export async function readDimensions(admin, appId) {
  const body = await (
    await admin.graphql(DEFINITION_QUERY, {
      variables: {namespace: dimensionNamespace(appId)},
    })
  ).json();

  const read = (which) => {
    const spec = DIMENSIONS[which];
    const node = body.data?.[spec.owner]?.nodes?.find(
      (definition) => definition.key === spec.key,
    );
    const capability = node?.capabilities?.analyticsQueryable;
    // The admin path takes the owner type lowercased and the numeric part of the GID.
    const id = node ? String(node.id).split('/').at(-1) : null;
    const owner = spec.ownerType.toLowerCase();
    const column = metafieldDimension(appId, which, spec.key);
    return {
      ...spec,
      defined: Boolean(node),
      eligible: Boolean(capability?.eligible),
      enabled: Boolean(capability?.enabled),
      dimension: spec.field ? `${column}.${spec.field}` : column,
      href: id && `shopify://admin/settings/custom_data/${owner}/metafields/${id}`,
    };
  };

  const product = read('product');
  // The analytics setting lives on the Campaign type, and the API doesn't expose it.
  // A query that parses is the only signal.
  if (product.defined) {
    const probe = await (
      await admin.graphql(dimensionProbeQuery(product.dimension))
    ).json();
    const parseErrors = probe.data?.shopifyqlQuery?.parseErrors;
    product.eligible = true;
    // A throttled probe says nothing about the setting. Report it as on.
    product.enabled = transportErrors(probe).length > 0 || parseErrors?.length === 0;
  }
  product.href = `shopify://admin/settings/custom_data/metaobjects/${CAMPAIGN_TYPE}`;

  return {product, customer: read('customer'), order: read('order')};
}
// [END campaign-dashboard.metafield-dimension-read]

// [START campaign-dashboard.enable-dimension]
// Eligible isn't queryable. Until a definition becomes a dimension, naming it in a
// query fails to parse. Address it by key and owner type, because neither takes an ID.
// A rejected mutation answers with `errors` and a null `data`, and an unchecked call
// leaves the button reporting success with the dimension still off.
export async function enableDimension(admin, definition) {
  const {ownerType} = definition;

  // The reference validates against the Campaign definition. Only the merchant can
  // make it queryable, and the dimension list links to the setting.
  if (definition.reference) {
    if (definition.defined) {
      return [
        {message: 'Turn on analytics for the Campaign type in the admin, then reload.'},
      ];
    }
    const {definitionId, userErrors} = await ensureDefinition(admin);
    if (!definitionId) return userErrors;
    const body = await (
      await admin.graphql(DEFINITION_CREATE, {
        variables: {
          definition: {
            name: definition.name,
            description: definition.description,
            namespace: DIMENSION_NAMESPACE,
            key: definition.key,
            type: 'metaobject_reference',
            ownerType,
            access: {admin: definition.adminAccess},
            validations: [{name: 'metaobject_definition_id', value: definitionId}],
          },
        },
      })
    ).json();
    return [
      ...transportErrors(body),
      ...(body.data?.metafieldDefinitionCreate?.userErrors ?? []),
    ];
  }

  if (!definition.defined) {
    const body = await (
      await admin.graphql(DEFINITION_CREATE, {
        variables: {
          definition: {
            name: definition.name,
            description: definition.description,
            namespace: DIMENSION_NAMESPACE,
            key: definition.key,
            type: 'single_line_text_field',
            ownerType,
            access: {admin: definition.adminAccess},
            capabilities: {analyticsQueryable: {enabled: true}},
          },
        },
      })
    ).json();
    return [
      ...transportErrors(body),
      ...(body.data?.metafieldDefinitionCreate?.userErrors ?? []),
    ];
  }

  const body = await (
    await admin.graphql(DEFINITION_UPDATE, {
      variables: {
        definition: {
          namespace: DIMENSION_NAMESPACE,
          key: definition.key,
          ownerType,
          capabilities: {analyticsQueryable: {enabled: true}},
        },
      },
    })
  ).json();
  return [
    ...transportErrors(body),
    ...(body.data?.metafieldDefinitionUpdate?.userErrors ?? []),
  ];
}
// [END campaign-dashboard.enable-dimension]
