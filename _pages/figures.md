---
layout: page
title: Figures
permalink: /figures/
order: 2
toc: Figures
description: "Interactive versions of the figures from our paper."
---

<script charset="utf-8" src="{{ site.baseurl }}{% link assets/plotly.min.js %}"></script>

### Figure 6

Successful requests per second over time. Every 1 min a new load generator was started, increasing the system load.

{% include request_per_client_flights.html %}

{% include request_per_client_forums.html %}

### Figure 7

Median Latency per Minute. Every 1 min an additional client was started, increasing the system load.

{% include latency_per_client_flights_read.html %}
{% include latency_per_client_forums_read.html %}
{% include latency_per_client_flights_write.html %}
{% include latency_per_client_forums_write.html %}
