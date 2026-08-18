import {DIMENSION_NAMESPACE, metafieldDimension} from './campaigns';
import {
  DEFINITION_CREATE,
  DEFINITION_QUERY,
  DEFINITION_UPDATE,
} from './campaign-queries.server';

// [START campaign-dashboard.metafield-dimension-read]
// The three definitions the app owns. `eligible` is whether the types can support a
// dimension, `enabled` is whether this app turned it on.
const DIMENSIONS = {
  product: {
    owner: 'products',
    ownerType: 'PRODUCT',
    key: 'promoted_by',
    name: 'Promoted by',
    description: 'The campaign that promoted this product.',
    // The app writes this at launch. A hand-edited value misattributes sales.
    adminAccess: 'MERCHANT_READ',
    // The report this blocks, and the section `id` the list links to.
    report: 'What the campaign promoted',
    anchor: 'promoted',
  },
  customer: {
    owner: 'customers',
    ownerType: 'CUSTOMER',
    key: 'tier',
    name: 'Campaign tier',
    description: 'The audience tier this customer was last targeted in.',
    adminAccess: 'MERCHANT_READ_WRITE',
    report: 'What the audience bought',
    anchor: 'audience-sales',
  },
  order: {
    owner: 'orders',
    ownerType: 'ORDER',
    key: 'campaign_touch',
    name: 'Campaign touch',
    description: 'The campaign send or event this order followed.',
    adminAccess: 'MERCHANT_READ',
    report: 'Which touch the orders followed',
    anchor: 'touch-sales',
  },
};

export async function readDimensions(admin) {
  const body = await (
    await admin.graphql(DEFINITION_QUERY, {
      variables: {namespace: DIMENSION_NAMESPACE},
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
    return {
      ...spec,
      defined: Boolean(node),
      eligible: Boolean(capability?.eligible),
      enabled: Boolean(capability?.enabled),
      dimension: metafieldDimension(which, spec.key),
      href: id && `shopify://admin/settings/custom_data/${owner}/metafields/${id}`,
    };
  };

  return {product: read('product'), customer: read('customer'), order: read('order')};
}
// [END campaign-dashboard.metafield-dimension-read]

// [START campaign-dashboard.enable-dimension]
// Eligible isn't queryable. Until a definition is made a dimension, naming it in a
// query fails to parse. Addressed by key and owner type, because neither takes an ID.
export async function enableDimension(admin, definition) {
  const {ownerType} = definition;

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
    return body.data?.metafieldDefinitionCreate?.userErrors ?? [];
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
  return body.data?.metafieldDefinitionUpdate?.userErrors ?? [];
}
// [END campaign-dashboard.enable-dimension]
