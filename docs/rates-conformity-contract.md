# Rates Conformity Contract

Last updated: 2026-03-28T20:15:00Z

This contract defines the adapter-level pricing structure required to power UX pricing consistently across all PM adapters.

## Purpose

Rates conformity is not only "do listing JSON files have `normalized_rates.days`".

Rates conformity means each adapter can drive:

- daily or proxy-daily price presentation
- all-in estimate (fees + taxes)
- optional ad-hoc quote fetch
- checkout/link-out handoff with parameterized PM URL signatures

Listing-level scraped rates remain first-class when available, but they are not the only path to conformity.

## Canonical Storage Model

Each adapter must maintain two pricing artifacts:

1. `src/lib/data/external-sources/<adapterKey>/pricing-assumptions.json`
2. `src/lib/data/external-sources/<adapterKey>/pricing-profile.json`

`pricing-assumptions.json` is already defined by [adapter-pricing-assumptions.md](./adapter-pricing-assumptions.md).

`pricing-profile.json` is the adapter-level control plane for acquisition + UX behavior.

## Adapter Pricing Profile Structure

```json
{
  "adapter_key": "30aescapes",
  "platform_family": "track_bluetent",
  "currency": "USD",
  "rates_conformity": {
    "status": "in_progress",
    "ready": false,
    "last_validated_at": "2026-03-28T19:00:00.000Z",
    "blocking_gaps": [
      "quote parser not normalized",
      "handoff signature map not stored"
    ]
  },
  "capabilities": {
    "listing_daily_rates": {
      "supported": false,
      "source": "normalized_rates.days"
    },
    "ad_hoc_quote": {
      "supported": true,
      "transport": "http_post_form",
      "response_format": "html_fragment"
    },
    "checkout_handoff": {
      "supported": true,
      "transport": "url",
      "requires_quote_context": true
    }
  },
  "quote_signature": {
    "method": "POST",
    "url": "https://www.30aescapes.com/rentals/ajax/get-pdp-rates.cfm",
    "content_type": "application/x-www-form-urlencoded",
    "required_params": [
      "formtype",
      "page",
      "propertyid",
      "unitshortname",
      "redskyclient",
      "strcheckin",
      "strcheckout"
    ],
    "fixed_params": {
      "formtype": "details-datepicker",
      "page": "0",
      "redskyclient": "no"
    },
    "date_param_format": "MM/DD/YYYY",
    "response_extractors": {
      "rent_total": "li:contains('Rent') .text-right",
      "taxes_total": "li:contains('Taxes') .text-right",
      "all_in_total": ".pdp-quote-total"
    }
  },
  "quote_retrieval_hints": {
    "fast_path": "direct_api",
    "direct_api": {
      "required_headers": ["user-agent"],
      "recommended_headers": ["accept", "referer", "x-requested-with"],
      "notes": "Non-empty user-agent is required for many anti-bot front doors."
    },
    "fallback_path": {
      "mode": "browser_bootstrap_then_direct_api",
      "trigger_on_status_codes": [403, 406, 429]
    }
  },
  "handoff_signature": {
    "url_template": "https://www.30aescapes.com/rentals/book-now.cfm?propertyid={propertyid}&strcheckin={checkin}&strcheckout={checkout}",
    "required_params": ["propertyid", "strcheckin", "strcheckout"],
    "date_param_format": "MM/DD/YYYY",
    "source": "quote_response"
  },
  "estimation_policy": {
    "nightly_base_strategy": "quote_window_average",
    "fees_taxes_strategy": "adapter_assumptions_multiplier",
    "fallback_order": [
      "listing_daily_rates",
      "ad_hoc_quote_window_average",
      "adapter_assumptions"
    ]
  },
  "assumptions_policy": {
    "min_samples_for_ready": 3,
    "max_sample_age_days": 45,
    "refresh_cadence": "monthly"
  }
}
```

## Required UX Output Contract

For any listing/date request, pricing engine should emit a normalized object:

```json
{
  "adapter_key": "30aescapes",
  "external_listing_id": "161782",
  "check_in_date": "2026-04-10",
  "check_out_date": "2026-04-13",
  "nights": 3,
  "currency": "USD",
  "base_total": 3333.8,
  "taxes_total": 400.06,
  "fees_total": null,
  "all_in_total": 3733.86,
  "avg_base_nightly": 1111.27,
  "avg_all_in_nightly": 1244.62,
  "estimate_confidence": "high",
  "pricing_mode": "ad_hoc_quote",
  "handoff_url": "https://www.30aescapes.com/rentals/book-now.cfm?...",
  "captured_at": "2026-03-28T19:00:00.000Z"
}
```

## Estimation Rules

When direct quote totals are present:

$$
avg\_base\_nightly = \frac{base\_total}{nights}
$$

$$
avg\_allin\_nightly = \frac{all\_in\_total}{nights}
$$

When only base estimate is available:

$$
estimated\_all\_in \approx base\_total \times avg\_all\_in\_multiplier
$$

or

$$
estimated\_all\_in \approx base\_total \times (1 + avg\_fee\_pct\_of\_base + avg\_tax\_pct\_of\_base)
$$

## Rates Ready Definition

Adapter is `Rates Ready` when all are true:

1. `pricing-profile.json` exists with valid quote/handoff/estimation metadata.
2. `pricing-assumptions.json` exists with at least `min_samples_for_ready` samples.
3. Pricing engine can produce normalized UX pricing output for any listing/date request.
4. If quote is supported, quote signature is documented and probe-verified.
5. If checkout handoff is supported, URL signature mapping is documented and probe-verified.

Adapters may be Rates Ready without listing-level daily scraped rates if they satisfy quote/assumption pathways.

## Operational Notes

- Keep list-level scraped rates in detail JSON where available.
- Treat quote signatures as adapter-level reusable contracts, not one-off probe artifacts.
- Persist probe evidence in `.tmp/reports/*` and summarize essential signature fields into `pricing-profile.json`.
- Re-validate profiles after major PM frontend changes.
- For direct API quote probes, always send a non-empty `user-agent` header. Do not send an empty user-agent.
- Where practical, use direct API as fast path and fall back to browser bootstrap/session only on blocked responses.
