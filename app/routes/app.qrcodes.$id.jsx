import { useState, useEffect, useRef } from "react";
import {
  useActionData,
  useLoaderData,
  useSubmit,
  useParams,
  useRouteError,
} from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

import {
  getQRCode,
  validateQRCode,
  saveQRCode,
  upsertMarketingActivity,
  deleteQRCode,
  endMarketingActivity,
  generateHandle,
} from "../models/QRCode.server";
import {
  assignQRCode,
  campaignOf,
  readCampaigns,
  withReturnedErrors,
} from "../campaigns.server";
import { isCalendarDate, shortDate, statusLabel } from "../campaigns";

// [START campaign-dashboard.qr-campaign-picker]
// Activation writes a mark for each code, and a target when the campaign sets a QR
// target. Codes join and leave a campaign before activation.
const assignable = (campaign) => campaign.status === "planned";

async function campaignChoices(admin, qrCodeId) {
  const { campaigns, failed } = await readCampaigns(withReturnedErrors(admin));
  const current = qrCodeId ? campaignOf(campaigns, qrCodeId) : null;
  return {
    failed,
    current,
    locked: Boolean(current && !assignable(current)),
    campaigns: campaigns
      .filter((campaign) => assignable(campaign) || campaign === current)
      .map((campaign) => ({
        gid: campaign.gid,
        title: campaign.title,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
      })),
  };
}

// The code's annotation and target start on this day. Blank goes live with the campaign.
function liveOnError(liveOn, choice) {
  if (!liveOn) return null;
  if (!choice) return "Select a campaign to set a live date.";
  return !isCalendarDate(liveOn) || liveOn < choice.startDate || liveOn > choice.endDate
    ? `Select a day from ${shortDate(choice.startDate)} to ${shortDate(choice.endDate)}.`
    : null;
}

const CAMPAIGNS_FAILED = "Couldn't load campaigns. Reload to try again.";

async function qrCodeIdOf(admin, handle) {
  const response = await admin.graphql(
    `query QRCodeId($handle: MetaobjectHandleInput!) {
      metaobjectByHandle(handle: $handle) { id }
    }`,
    { variables: { handle: { type: "$app:qrcode", handle } } },
  );
  const { data } = await response.json();
  return data?.metaobjectByHandle?.id ?? null;
}
// [END campaign-dashboard.qr-campaign-picker]

export async function loader({ request, params }) {
  // [START authenticate]
  const { admin, session } = await authenticate.admin(request);
  // [END authenticate]

  // [START data]
  if (params.id === "new") {
    const { campaigns, failed } = await campaignChoices(admin, null);
    // A campaign page links here with its campaign picked.
    const picked = new URL(request.url).searchParams.get("campaign");
    return {
      destination: "product",
      title: "",
      campaign: campaigns.some((option) => option.gid === picked) ? picked : "",
      liveOn: "",
      campaigns,
      campaignsFailed: failed.length > 0,
      campaignError: failed.length ? CAMPAIGNS_FAILED : null,
      shop: session.shop,
    };
  }

  const qrCode = await getQRCode(params.id, admin.graphql, session.shop);
  if (!qrCode) throw new Response("No QR code has this handle.", { status: 404 });
  const { campaigns, current, failed, locked } = await campaignChoices(
    admin,
    qrCode?.id,
  );
  const unsaved = new URL(request.url).searchParams.get("campaign") === "unsaved";
  return {
    ...qrCode,
    campaign: current?.gid ?? "",
    liveOn: (current && qrCode?.liveOn) || "",
    campaigns,
    campaignLocked: locked,
    campaignsFailed: failed.length > 0,
    campaignError: failed.length
      ? CAMPAIGNS_FAILED
      : unsaved
        ? "The code saved, but the campaign didn't. Select it again and save."
        : null,
    shop: session.shop,
  };
  // [END data]
}

// [START action]
export async function action({ request, params }) {
  // [START qr-marketing.save-activity]
  const { admin, session, redirect } = await authenticate.admin(request);
  // [END qr-marketing.save-activity]

  const data = Object.fromEntries(await request.formData());
  // The URL's handle names the code. A posted ID could name any metaobject on the shop.
  const qrCodeId = params.id === "new" ? null : await qrCodeIdOf(admin, params.id);

  if (data.action === "delete") {
    if (!qrCodeId) return redirect("/app/qrcodes");
    // An active or closed campaign reports on its codes, and a canceled one replans with
    // them. Deleting one would change it.
    const choices = await campaignChoices(admin, qrCodeId);
    if (choices.failed.length || choices.locked) {
      return new Response(
        JSON.stringify({
          errors: {
            campaign: choices.failed.length
              ? "Couldn't load campaigns. Try again."
              : `Only a planned campaign's codes can be deleted. This code's campaign is ${statusLabel(choices.current.status).toLowerCase()}.`,
          },
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      );
    }
    // A failed delete leaves the code and its campaign as they were. The campaign's
    // reference to a deleted code drops out when `readCampaigns` resolves the handles.
    try {
      await deleteQRCode(qrCodeId, admin.graphql);
    } catch (error) {
      console.error("Could not delete the QR code", error);
      return new Response(
        JSON.stringify({ errors: { campaign: "Couldn't delete the code. Try again." } }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      );
    }
    try {
      // On this page params.id is the code's handle, the activity's remoteId.
      await endMarketingActivity(params.id, session.shop, admin.graphql);
    } catch (error) {
      console.error("Could not end the marketing activity", error);
    }
    return redirect("/app/qrcodes");
  }

  const errors = validateQRCode(data);

  if (errors) {
    return new Response(JSON.stringify({ errors }), {
      status: 422,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  // [START campaign-dashboard.qr-campaign-save]
  // The form posts the campaign and live date it loaded with. Unchanged fields stay
  // as stored. The form can post any GID or day, so the server checks both.
  const campaign = data.campaign || null;
  const liveOn = campaign ? data.liveOn || "" : "";
  const reassigned = campaign !== (data.initialCampaign || null);
  const moved = reassigned || liveOn !== (data.initialLiveOn || "");
  const choices = moved
    ? await campaignChoices(admin, qrCodeId)
    : null;
  const choice = choices?.campaigns.find((option) => option.gid === campaign);
  const campaignError = !choices
    ? null
    : choices.failed.length
      ? "Couldn't load campaigns. Try again."
      : choices.locked
        ? "QR codes move only between planned campaigns."
        : campaign && !choice
          ? "Select a planned campaign."
          : null;
  const dateError = choices && !campaignError ? liveOnError(liveOn, choice) : null;
  if (campaignError || dateError) {
    return new Response(
      JSON.stringify({
        errors: campaignError ? { campaign: campaignError } : { liveOn: dateError },
      }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    );
  }
  // [END campaign-dashboard.qr-campaign-save]

  const handle =
    params.id === "new" ? generateHandle(data.title) : params.id;

  const metaobject = await saveQRCode(
    handle,
    { ...data, liveOn: moved ? liveOn : undefined },
    admin.graphql,
  );

  // [START campaign-dashboard.qr-campaign-assign]
  // The campaign entry holds the link. Assigning drops the code from any other campaign.
  // The code saved already. A failure lands on its page, where a resave can't duplicate it.
  const unassigned = reassigned
    ? await assignQRCode(withReturnedErrors(admin), metaobject.id, campaign)
    : [];
  if (unassigned.length) {
    console.error("Could not assign the QR code", unassigned);
  }
  // [END campaign-dashboard.qr-campaign-assign]

  // [START qr-marketing.save-activity]
  try {
    await upsertMarketingActivity(
      metaobject.handle,
      data.title,
      session.shop,
      admin.graphql,
    );
  } catch (error) {
    // The code is already saved. The next save retries the registration.
    console.error("Could not register the marketing activity", error);
  }
  // [END qr-marketing.save-activity]

  return redirect(
    `/app/qrcodes/${metaobject.handle}${unassigned.length ? "?campaign=unsaved" : ""}`,
  );
}
// [END action]

export default function QRCodeForm() {
  const { id } = useParams();

  // [START state]
  const loaderData = useLoaderData();
  const qrCode = loaderData;
  const [initialFormState, setInitialFormState] = useState(qrCode);
  const [formState, setFormState] = useState(qrCode);
  const errors = useActionData()?.errors || {};
  const chosenCampaign = (loaderData.campaigns ?? []).find(
    (option) => option.gid === formState.campaign,
  );
  const isDirty =
    JSON.stringify(formState) !== JSON.stringify(initialFormState);
  // [END state]

  // [START select-product]
  async function selectProduct() {
    const products = await window.shopify.resourcePicker({
      type: "product",
      action: "select",
      filter: { variants: true },
      selectionIds: formState.productId
        ? [
            {
              id: formState.productId,
              variants: formState.productVariantId
                ? [{ id: formState.productVariantId }]
                : [],
            },
          ]
        : [],
    });

    if (products) {
      const { images, id, variants, title } = products[0];

      setFormState({
        ...formState,
        productId: id,
        productVariantId: variants[0].id,
        productTitle: title,
        productAlt: images[0]?.altText,
        productImage: images[0]?.originalSrc,
      });
    }
  }

  function removeProduct() {
    setFormState({
      title: formState.title,
      destination: formState.destination,
      campaign: formState.campaign,
      liveOn: formState.liveOn,
    });
  }

  const productUrl = formState.productId
    ? `shopify://admin/products/${formState.productId.split("/").at(-1)}`
    : "";
  // [END select-product]

  // [START use-submit]
  const submit = useSubmit();

  function handleSave(e) {
    e.preventDefault();

    const data = {
      title: formState.title,
      productId: formState.productId || "",
      productVariantId: formState.productVariantId || "",
      destination: formState.destination,
      campaign: formState.campaign || "",
      // A new code starts on no campaign, even one picked from a campaign page.
      initialCampaign: initialFormState.id ? initialFormState.campaign || "" : "",
      liveOn: formState.campaign ? formState.liveOn || "" : "",
      initialLiveOn: initialFormState.liveOn || "",
      metaobjectId: initialFormState.id || "",
    };

    submit(data, { method: "post" });
  }

  function handleDelete(e) {
    e.preventDefault();
    submit(
      { action: "delete", metaobjectId: initialFormState.id },
      { method: "post" },
    );
  }
  // [END use-submit]

  // [START save-bar]
  const saveBarRef = useRef(null);

  function handleReset() {
    setFormState(initialFormState);
    saveBarRef.current?.hide();
  }

  useEffect(() => {
    const saveBar = saveBarRef.current;
    if (!saveBar) return;

    if (isDirty) {
      saveBar.show();
    } else {
      saveBar.hide();
    }
  }, [isDirty]);

  useEffect(() => {
    setInitialFormState(qrCode);
    setFormState(qrCode);
  }, [id, qrCode]);

  return (
    <>
      <ui-save-bar ref={saveBarRef} id="qr-code-form">
        <button variant="primary" onClick={handleSave}></button>
        <button onClick={handleReset}></button>
      </ui-save-bar>
      {/* [END save-bar] */}
      <form onSubmit={handleSave} onReset={handleReset}>
        {/* [START polaris] */}
        <s-page heading={initialFormState.title || "Create QR code"}>
          {/* [START breadcrumbs] */}
          <s-link
            href="/app/qrcodes"
            slot="breadcrumb-actions"
          >
          {/* [END breadcrumbs] */}
            QR codes
          </s-link>
          {initialFormState.handle &&
            <s-button slot="secondary-actions" commandFor="delete-qr-code" command="--show">
              Delete
            </s-button>}
          {initialFormState.handle &&
            <s-modal id="delete-qr-code" heading="Delete this QR code?">
              <s-paragraph>
                Scans of the printed code stop reaching the product. You can't undo this.
              </s-paragraph>
              <s-button slot="secondary-actions" commandFor="delete-qr-code" command="--hide">
                Go back
              </s-button>
              <s-button
                slot="primary-action"
                variant="primary"
                tone="critical"
                commandFor="delete-qr-code"
                command="--hide"
                onClick={handleDelete}
              >
                Delete QR code
              </s-button>
            </s-modal>}
          <s-section heading="QR code information">
            <s-stack gap="base">
              {/* [START title] */}
              <s-text-field
                label="Title"
                details="Shows on the code's public page"
                error={errors.title}
                autocomplete="off"
                name="title"
                value={formState.title}
                onInput={(e) =>
                  setFormState({ ...formState, title: e.target.value })
                }
              ></s-text-field>
              {/* [END title] */}
              {/* [START destination] */}
              <s-stack gap="base" justifyContent="space-between" alignItems="start">
                <s-select
                  name="destination"
                  label="Scan destination"
                  value={formState.destination}
                  onChange={(e) =>
                    setFormState({ ...formState, destination: e.target.value })
                  }
                >
                  <s-option
                    value="product"
                    selected={formState.destination === "product"}
                  >
                    Link to product page
                  </s-option>
                  <s-option
                    value="cart"
                    selected={formState.destination === "cart"}
                  >
                    Link to checkout page with product in the cart
                  </s-option>
                </s-select>
                {initialFormState.destinationUrl ? (
                  <s-link
                    href={initialFormState.destinationUrl}
                    target="_blank"
                  >
                    Go to destination URL
                  </s-link>
                ) : null}
              </s-stack>
              {/* [END destination] */}
              {/* [START campaign-dashboard.qr-campaign-field] */}
              <s-select
                name="campaign"
                label="Campaign"
                details={
                  loaderData.campaignLocked
                    ? "QR codes move only between planned campaigns."
                    : "The campaign page reports this code's attributed sales."
                }
                disabled={loaderData.campaignLocked || loaderData.campaignsFailed}
                error={errors.campaign ?? loaderData.campaignError}
                value={formState.campaign || ""}
                onChange={(e) =>
                  setFormState({ ...formState, campaign: e.currentTarget.value, liveOn: "" })
                }
              >
                <s-option value="">No campaign</s-option>
                {(loaderData.campaigns ?? []).map((campaign) => (
                  <s-option key={campaign.gid} value={campaign.gid}>
                    {campaign.title}
                  </s-option>
                ))}
              </s-select>
              {formState.campaign ? (
                <s-date-field
                  name="liveOn"
                  label="Live on"
                  details={
                    chosenCampaign
                      ? `${shortDate(chosenCampaign.startDate)} to ${shortDate(chosenCampaign.endDate)}. Leave blank to go live with the campaign. The code's annotation and target start on this day.`
                      : "Leave blank to go live with the campaign."
                  }
                  disabled={loaderData.campaignLocked || loaderData.campaignsFailed}
                  error={errors.liveOn}
                  allow={chosenCampaign ? `${chosenCampaign.startDate}--${chosenCampaign.endDate}` : undefined}
                  value={formState.liveOn || ""}
                  onChange={(e) =>
                    setFormState({ ...formState, liveOn: e.currentTarget.value })
                  }
                />
              ) : null}
              {/* [END campaign-dashboard.qr-campaign-field] */}
              {/* [START product] */}
              <s-stack gap="small-400">
                <s-stack direction="inline" gap="small-100" justifyContent="space-between">
                  <s-text color="subdued">Product</s-text>
                  {formState.productId ? (
                    <s-link
                      onClick={removeProduct}
                      accessibilityLabel="Remove the product from this QR code"
                      tone="neutral"
                    >
                      Clear
                    </s-link>
                  ) : null}
                </s-stack>
                {formState.productId ? (
                  <s-stack
                    direction="inline"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <s-stack
                      direction="inline"
                      gap="small-100"
                      alignItems="center"
                    >
                      <s-clickable
                        href={productUrl}
                        target="_blank"
                        accessibilityLabel={`Go to the product page for ${formState.productTitle}`}
                        borderRadius="base"
                      >
                        <s-box
                          padding="small-200"
                          border="base"
                          borderRadius="base"
                          background="subdued"
                          inlineSize="38px"
                          blockSize="38px"
                        >
                          {formState.productImage ? (
                            <s-image src={formState.productImage}></s-image>
                          ) : (
                            <s-icon type="product" />
                          )}
                        </s-box>
                      </s-clickable>
                      <s-link href={productUrl} target="_blank">
                        {formState.productTitle}
                      </s-link>
                    </s-stack>
                    <s-stack direction="inline" gap="small">
                      <s-button
                        onClick={selectProduct}
                        accessibilityLabel="Change the product the QR code should be for"
                      >
                        Change
                      </s-button>
                    </s-stack>
                  </s-stack>
                ) : (
                  <s-button
                    onClick={selectProduct}
                    accessibilityLabel="Select the product the QR code should be for"
                  >
                    Select product
                  </s-button>
                )}
                {errors.productId ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                    <s-icon type="alert-circle" tone="critical" size="small" />
                    <s-text tone="critical">{errors.productId}</s-text>
                  </div>
                ) : null}
              </s-stack>
            </s-stack>
          </s-section>
          {/* [END product] */}
          {/* [START preview] */}
          <s-box slot="aside">
            <s-section heading="Preview">
              <s-stack gap="base">
                <s-box
                  padding="base"
                  border="none"
                  borderRadius="base"
                  background="subdued"
                >
                  {initialFormState.image ? (
                    <s-image
                      aspectRatio="1/0.8"
                      src={initialFormState.image}
                      alt="The QR code for the current form"
                    />
                  ) : (
                    <s-stack
                      direction="inline"
                      alignItems="center"
                      justifyContent="center"
                      blockSize="198px"
                    >
                      <s-text color="subdued">
                        See a preview once you save
                      </s-text>
                    </s-stack>
                  )}
                </s-box>
                <s-stack
                  gap="small"
                  direction="inline"
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <s-button
                    disabled={!initialFormState.handle}
                    href={`/qrcodes/${initialFormState.handle}?shop=${loaderData.shop}`}
                    target="_blank"
                  >
                    Go to public URL
                  </s-button>
                  <s-button
                    disabled={!initialFormState?.image}
                    href={initialFormState?.image}
                    download={`${initialFormState?.handle ?? "qr-code"}.png`}
                    variant="primary"
                  >
                    Download
                  </s-button>
                </s-stack>
              </s-stack>
            </s-section>
          </s-box>
          {/* [END preview] */}
        </s-page>
        {/* [END polaris] */}
      </form>
    </>
  );
}

// Without a boundary here, a failed load takes AppProvider and the app's navigation with it.
export function ErrorBoundary() {
  const error = useRouteError();
  const detail = error?.data ?? error?.message ?? "The load failed.";
  return (
    <s-page heading="QR code">
      <s-section>
        <s-banner tone="critical" heading="Couldn't load the QR code">
          <s-paragraph>{String(detail)}</s-paragraph>
        </s-banner>
        <s-box paddingBlockStart="base">
          <s-link href="/app/qrcodes">Back to QR codes</s-link>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
