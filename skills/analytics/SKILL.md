---
name: analytics
description: Growth analytics authority — GA4 event tracking, conversion funnels, attribution models, cohort analysis, A/B testing, Supabase analytics queries, and revenue reporting patterns
---

# analytics

Covers measurement, attribution, and reporting for growth systems: web analytics, conversion funnels, cohort analysis, and revenue tracking.

## 1) GA4 event taxonomy

```javascript
// Standardised event naming: object_action
gtag('event', 'article_view',    { article_slug, word_count, cluster });
gtag('event', 'email_signup',    { source, form_id, article_slug });
gtag('event', 'purchase',        { value, currency, product_id, funnel_stage });
gtag('event', 'outbound_click',  { link_url, link_text, page_path });
gtag('event', 'scroll_depth',    { percent_scrolled: 75, article_slug });

// Conversion events (mark as Key Events in GA4)
// email_signup, purchase, trial_start, demo_booked
```

## 2) Conversion funnel tracking

```python
# Funnel stages — track at each transition
FUNNEL = [
    ("landing",    "user hits any page"),
    ("engaged",    "scroll > 60% or time > 90s"),
    ("intent",     "visits pricing, about, or contact page"),
    ("signup",     "email captured"),
    ("activated",  "completes onboarding action"),
    ("converted",  "purchase or subscription"),
    ("retained",   "returns within 30 days"),
]

# Supabase funnel query
FUNNEL_QUERY = """
WITH events AS (
  SELECT user_id, event_name, created_at
  FROM analytics_events
  WHERE created_at >= NOW() - INTERVAL '30 days'
)
SELECT
  COUNT(DISTINCT CASE WHEN event_name = 'page_view'   THEN user_id END) AS landing,
  COUNT(DISTINCT CASE WHEN event_name = 'engaged'     THEN user_id END) AS engaged,
  COUNT(DISTINCT CASE WHEN event_name = 'email_signup' THEN user_id END) AS signup,
  COUNT(DISTINCT CASE WHEN event_name = 'purchase'    THEN user_id END) AS converted
FROM events;
"""
```

## 3) Attribution models

```python
# First-touch: credit goes to first touchpoint
# Last-touch: credit goes to last touchpoint (GA4 default)
# Linear: equal credit to all touchpoints
# Time-decay: more credit to recent touchpoints
# Data-driven: ML-based (GA4 Pro only)

# Simple first/last-touch implementation
def attribute_conversion(touchpoints: list[dict], model: str = "linear") -> dict[str, float]:
    if not touchpoints:
        return {}
    if model == "first_touch":
        return {touchpoints[0]["source"]: 1.0}
    if model == "last_touch":
        return {touchpoints[-1]["source"]: 1.0}
    if model == "linear":
        weight = 1.0 / len(touchpoints)
        result: dict[str, float] = {}
        for t in touchpoints:
            result[t["source"]] = result.get(t["source"], 0.0) + weight
        return result
    raise ValueError(f"Unknown model: {model}")
```

## 4) Cohort analysis

```sql
-- Weekly retention cohort (Supabase / PostgreSQL)
WITH cohorts AS (
  SELECT
    user_id,
    DATE_TRUNC('week', MIN(created_at)) AS cohort_week
  FROM users
  GROUP BY user_id
),
activity AS (
  SELECT
    user_id,
    DATE_TRUNC('week', created_at) AS activity_week
  FROM events
  WHERE event_name = 'session_start'
),
cohort_size AS (
  SELECT cohort_week, COUNT(DISTINCT user_id) AS users
  FROM cohorts GROUP BY cohort_week
)
SELECT
  c.cohort_week,
  (DATE_PART('day', a.activity_week - c.cohort_week) / 7)::int AS week_number,
  COUNT(DISTINCT a.user_id)::float / cs.users AS retention_rate
FROM cohorts c
JOIN activity a USING (user_id)
JOIN cohort_size cs ON cs.cohort_week = c.cohort_week
GROUP BY 1, 2, cs.users
ORDER BY 1, 2;
```

## 5) A/B testing framework

```python
import hashlib

def assign_variant(user_id: str, experiment_id: str, variants: list[str]) -> str:
    """Deterministic assignment — same user always gets same variant."""
    hash_input = f"{experiment_id}:{user_id}".encode()
    hash_int = int(hashlib.md5(hash_input).hexdigest(), 16)
    return variants[hash_int % len(variants)]

# Significance test (two-proportion z-test)
from scipy import stats

def is_significant(control_n: int, control_conv: int,
                   test_n: int, test_conv: int,
                   alpha: float = 0.05) -> bool:
    _, p_value = stats.proportions_ztest(
        [control_conv, test_conv],
        [control_n, test_n],
    )
    return p_value < alpha

# Minimum detectable effect / sample size
def min_sample_size(baseline_rate: float, mde: float, alpha=0.05, power=0.80) -> int:
    from statsmodels.stats.power import NormalIndPower
    effect = mde / (baseline_rate * (1 - baseline_rate)) ** 0.5
    return int(NormalIndPower().solve_power(effect_size=effect, alpha=alpha, power=power))
```

## 6) Revenue metrics

```python
REVENUE_METRICS = {
    # Acquisition
    "CAC":          "total_sales_marketing_spend / new_customers",
    "CPL":          "ad_spend / leads_generated",
    # Monetisation
    "LTV":          "avg_order_value × purchase_frequency × customer_lifespan",
    "LTV:CAC":      "target > 3:1",
    "MRR":          "sum of monthly recurring revenue",
    "ARR":          "MRR × 12",
    # Retention
    "churn_rate":   "customers_lost / customers_start_of_period",
    "NRR":          "Net Revenue Retention: (MRR_end + expansion - churn) / MRR_start",
    # Engagement
    "DAU_MAU":      "stickiness ratio, target > 0.20",
}

# Supabase MRR query
MRR_QUERY = """
SELECT
  DATE_TRUNC('month', created_at) AS month,
  SUM(amount) / 100.0             AS mrr_usd,
  COUNT(DISTINCT user_id)         AS paying_users
FROM payments
WHERE status = 'succeeded'
GROUP BY 1 ORDER BY 1 DESC LIMIT 12;
"""
```

## 7) UTM tracking conventions

```
# Standard UTM structure
utm_source   = traffic origin (google, newsletter, twitter, apollo)
utm_medium   = channel type (cpc, email, social, organic)
utm_campaign = campaign name (keto-jan-2026, webinar-feb)
utm_content  = creative variant (headline-a, cta-blue)
utm_term     = paid keyword (keto diet, low carb)

# Examples
?utm_source=apollo&utm_medium=email&utm_campaign=icp-outbound-q1
?utm_source=google&utm_medium=cpc&utm_campaign=brand&utm_term=ketoandhealthy
?utm_source=newsletter&utm_medium=email&utm_campaign=weekly-digest-2026-01-15
```

## 8) Analytics checklist

- [ ] GA4 measurement ID installed and firing on all pages
- [ ] Key conversion events marked as Key Events in GA4
- [ ] UTM parameters on all paid/email/social links
- [ ] Funnel stages defined and tracked as events
- [ ] Weekly cohort retention query scheduled
- [ ] A/B tests have pre-calculated sample size before launch
- [ ] LTV:CAC ratio tracked monthly (alert if < 2:1)
- [ ] Revenue dashboard (MRR, ARR, churn) refreshing daily
- [ ] Attribution model documented and consistent across reports
