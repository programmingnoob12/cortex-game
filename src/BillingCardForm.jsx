// BillingCardForm.jsx
//
// Referenced from the main app file as a default export — drop this file
// alongside it and the `typeof BillingCardForm === "function"` check there
// will pick it up automatically, replacing the "card form mounts here"
// placeholder with the real thing.

import { useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";

const STRIPE_PUBLISHABLE_KEY = "pk_test_51LWmPKIUM9SdKsj1bdD2uLndjdet0b306mTFPXNXRw9lPt6swwW8Ab5F2dLwmvku3jcGL2ur5pHfl6rryakxEmT000QkCO4SuI";
const stripePromise = loadStripe(STRIPE_PUBLISHABLE_KEY);

// Same dark theme as the checkout page and the rest of the app's Stripe
// surfaces, so this doesn't look like a visually different third UI.
const appearance = {
  theme: "night",
  variables: {
    colorPrimary: "#10b981",
    colorBackground: "#0a0a0a",
    colorText: "#f5f5f5",
    colorTextSecondary: "#a1a1aa",
    colorDanger: "#f87171",
    fontFamily: "'Inter', system-ui, sans-serif",
    borderRadius: "10px",
    spacingUnit: "4px",
  },
  rules: {
    ".Tab": { border: "1px solid #27272a", backgroundColor: "#111113" },
    ".Tab:hover": { backgroundColor: "#18181b" },
    ".Tab--selected": { border: "1px solid #10b981", backgroundColor: "#111113" },
    ".Input": { border: "1px solid #27272a", backgroundColor: "#111113" },
    ".Input:focus": { border: "1px solid #10b981", boxShadow: "0 0 0 1px #10b981" },
    ".Label": { color: "#a1a1aa", fontSize: "13px" },
  },
};

function InnerForm({ onDone, onError }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setLocalError("");

    // "if_required" keeps the person on this screen — Stripe only redirects
    // when a payment method genuinely requires it (rare for cards).
    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
    });

    if (error) {
      const message = error.message || "Could not save card — please try again.";
      setLocalError(message);
      onError?.(message);
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
    // Confirming a SetupIntent only ATTACHES the card to the customer. It
    // does not make it the card the subscription bills. Hand the intent id
    // back so the server can promote it to default.
    onDone?.(setupIntent?.id);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      {localError && <p className="text-sm text-red-400">{localError}</p>}
      <button
        type="submit"
        disabled={!stripe || submitting}
        className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors rounded-lg py-4 text-base font-medium text-white"
      >
        {submitting ? "Saving…" : "Save card"}
      </button>
    </form>
  );
}

export default function BillingCardForm({ clientSecret, onDone, onError }) {
  if (!clientSecret) return null;
  return (
    <Elements stripe={stripePromise} options={{ clientSecret, appearance }}>
      <InnerForm onDone={onDone} onError={onError} />
    </Elements>
  );
}
