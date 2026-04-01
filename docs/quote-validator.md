# Quote Validator

This document explains what the quote validator enforces and why it is a gate before adapter readiness.

## Purpose

The quote validator checks that quote sidecar records are structurally correct, internally consistent, and operationally useful for downstream pricing/handoff steps.

## Validation Scope

The validator typically checks:

- Required sidecar fields are present and typed correctly.
- Observation windows and dates are coherent.
- Numeric totals are finite and within expected constraints.
- Quote availability state and unavailable reasons are consistent.
- Handoff URL presence/shape for quote-available observations where applicable.

## Core Rules

Representative rule classes:

1. Contract shape rules

- Record-level required fields.
- Observation-level required fields.

2. Numeric integrity rules

- Amount fields are finite numbers.
- Derived ratios/multipliers are sane.

3. Window policy rules

- Expected cadence and max queries respected.
- No silent date-shift behavior for unavailable windows.

4. Consistency rules

- Totals/flags/reasons align with quote_available state.

## Outputs

The validator emits adapter-level pass/fail summaries and listing/window-level failures for targeted remediation.

This allows precision reruns on failed windows instead of full refresh in many cases.

## Relationship to Readiness

A passing quote validator is required but not sufficient for Ready.

Ready still depends on:

- Handoff parity validation.
- Pricing record parity.
- Baseline quality thresholds in conformance status.
