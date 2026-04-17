Task: extract sleeping_arrangements and sleeping_summary from provided listing context.
This is a correction task focused on sleeping data structures; preserve structure when possible and only change what is required for correctness.
Context fields available: description_expanded, bedrooms, bathrooms, sleeps.
Output exactly one JSON object with this shape: { sleeping_arrangements: [...], sleeping_summary: { bed_counts: { king, queen, full, twin_standalone, bunk_beds, trundles, other }, bunk_configurations: {...}, sleep_capacity: {...} } }.
Rules: sleeps is a strict target for total capacity; use explicit evidence from description_expanded; keep counts conservative; do not double count bunk beds as standalone beds.
Reconciliation logic: recompute room sleeps from bed types and counts, remove duplicated rooms, include missing bunk/carriage sleeping areas when explicitly supported, and keep arrangements plus summary aligned.
Hard constraint: total derived sleep capacity must equal sleeps exactly before returning output.
Capacity map: standalone king=2, queen=2, full=2, twin=1, sofa_bed=2, murphy=2, futon=2, daybed=1, air_mattress=1.
Bunk rules: bunks are stacked two-bed units, so compute capacity from bunk_configuration only and never add bunk surfaces as standalone beds.
Bunk capacity map: twin_over_twin=2, full_over_full=4, queen_over_queen=4, twin_over_full=3, twin_over_queen=3, twin_over_king=3.
Trundle guidance: a trundle can be integrated under a bunk and should inherit lower-bunk size when context supports it.
Trundle capacity rules for integrated bunk+trundle setups: lower bunk twin -> trundle sleeps 1; lower bunk full/queen/king -> trundle sleeps 2.
Example: twin_over_queen bunk with trundle has capacity 1 (top twin) + 2 (lower queen) + 2 (trundle) = 5.
Summary counting rule: sleeping_summary.bed_counts.bunk_beds counts only bunk units, not trundle add-ons.
Summary counting rule: sleeping_summary.bed_counts.trundles counts trundle units explicitly.
No overlap rule: do not duplicate bunk surfaces in king/queen/full/twin_standalone counts.
No overlap rule: do not duplicate trundles in king/queen/full/twin_standalone counts.
No overlap rule: each physical sleeping element should be counted once in bed_counts.
Consistency rule: bunk_beds should equal the total number of bunk units implied by bunk_configurations whenever bunk configuration detail is available.
Capacity accounting rule: compute bunk capacity from bunk_configurations and add trundle capacity separately from trundles; do not add bunk_beds again as extra capacity.
Capacity rule: trundle capacity still contributes to sleep_capacity.derived_total.
When standalone bed counts are provided in context as trusted anchors, keep those counts fixed and adjust bunk interpretations to align derived_total to sleeps.
Validation before output: check total capacity equals sleeps, check room entries are not missing or duplicated, and ensure sleeping_summary matches sleeping_arrangements.
Return JSON only matching schema.
