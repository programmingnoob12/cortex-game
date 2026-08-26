// Client-side billing API. Every call carries the signed-in user's Supabase
// access token; the server verifies it and resolves the Stripe customer from
// it, so the browser never names a customer, subscription or price id.
//
//   import { createBillingApi } from "./billing.js";
//   const billing = createBillingApi(supabase);
//   const state = await billing.getSubscription();

export function createBillingApi(supabase) {
  async function call(path, { method = "GET", body } = {}) {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("Not signed in");

    const res = await fetch(`/api/billing/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Server messages here are written to be shown to the person as-is.
      const err = new Error(json.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = json.code;
      throw err;
    }
    return json;
  }

  return {
    // --- read ---
    getSubscription: () => call("subscription"),
    getInvoices: () => call("invoices"),
    getCards: () => call("payment-methods"),

    // --- plan ---
    previewSwitch: (plan) => call("preview-switch", { method: "POST", body: { plan } }),
    // Pass the prorationDate from previewSwitch so the amount confirmed on
    // screen is the amount actually billed.
    switchPlan: (plan, prorationDate) =>
      call("switch", { method: "POST", body: { plan, prorationDate } }),

    // --- cancel ---
    cancel: (feedback, comment) => call("cancel", { method: "POST", body: { feedback, comment } }),
    reactivate: () => call("reactivate", { method: "POST" }),
    pause: (months) => call("pause", { method: "POST", body: { months } }),
    resume: () => call("pause", { method: "POST", body: { resume: true } }),

    // --- cards ---
    createSetupIntent: () => call("setup-intent", { method: "POST" }),
    setDefaultCard: (paymentMethodId) =>
      call("payment-methods", { method: "POST", body: { paymentMethodId } }),
    removeCard: (paymentMethodId) =>
      call("payment-methods", { method: "DELETE", body: { paymentMethodId } }),
    retryInvoice: (invoiceId) => call("retry-invoice", { method: "POST", body: { invoiceId } }),
  };
}

// Stripe's cancellation feedback enum, as the radio options for the cancel
// flow. Using their values verbatim means the reasons land in Stripe's own
// reporting rather than only in our table.
export const CANCEL_REASONS = [
  { value: "too_expensive", label: "Too expensive" },
  { value: "unused", label: "I'm not using it" },
  { value: "missing_features", label: "Missing features I need" },
  { value: "switched_service", label: "Switched to something else" },
  { value: "too_complex", label: "Too complicated" },
  { value: "low_quality", label: "Not good enough" },
  { value: "customer_service", label: "Support experience" },
  { value: "other", label: "Something else" },
];

// Appearance object for Stripe Elements, matching the app's palette so the
// card form doesn't read as a third-party embed.
export const STRIPE_APPEARANCE = {
  theme: "night",
  variables: {
    colorPrimary: "#4CB9D8",
    colorBackground: "#101112",
    colorText: "#F7F8F8",
    colorTextSecondary: "#8A8F98",
    colorTextPlaceholder: "#6E7178",
    colorDanger: "#EB5757",
    borderRadius: "8px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    spacingUnit: "4px",
  },
  rules: {
    ".Input": { backgroundColor: "#08090A", border: "1px solid #23252A", boxShadow: "none" },
    ".Input:focus": { border: "1px solid #4CB9D8", boxShadow: "none" },
    ".Label": { color: "#8A8F98", fontSize: "13px", fontWeight: "600" },
    ".Tab, .Block": { backgroundColor: "#18191B", border: "1px solid #23252A" },
    ".Tab--selected": { borderColor: "#4CB9D8", color: "#8FD8EC" },
    ".Error": { color: "#EB5757" },
  },
};
