---
layout: page
toc: Home
permalink: /
order: 1
title: "CRDT Web Caching: Additional Material"
description: "Additional material for the publication \"CRDT Web Caching: Enabling Distributed Writes and Fast Cache Consistency for REST APIs\", providing access to published data and tools."
---

The paper is published at [CNSM 2024](https://www.cnsm-conf.org/2024/). You can view it over **[[IFIP]](https://opendl.ifip-tc6.org/db/conf/cnsm/cnsm2024/1571043735.pdf)**.


<div class="accordion-box">
  <div class="accordion-box__title">
    Abstract
  </div>
  <div class="accordion-box__content">
      <p>Web Application developers have two main options to improve the performance of their REST APIs using Content Delivery Network (CDN) caches: define a Time to Live (TTL) or actively invalidate content. However, TTL-based caching is unsuited for the dynamic data exchanged via REST APIs, and neither can speed up write requests. Performance is important, as client latency directly impacts revenue, and a system’s scalability is determined by its achievable throughput. A new type of Web proxy that acts as an information broker for the underlying data rather than working on the level of HTTP requests presents new possibilities for enhancing REST APIs. Existing Conflict-free Replicated Data Type (CRDT) semantics and standards like JSON:API can serve as a basis for such a broker. We propose CRDT Web Caching (CWC) as a novel method for distributing application data in a network of Web proxies, enabling origins to automatically update outdated cached content and proxies to respond directly to write requests. We compared simple forwarding, TTL-based caching, invalidation-based caching, and CWC in a simulated CDN deployment. Our results show that TTL-based caching can achieve the best performance, but the long inconsistency window makes it unsuitable for dynamic REST APIs. CWC outperforms invalidation-based caching in terms of throughput and latency due to a higher cache-hit ratio, and it is the only option that can accelerate write requests. However, under high system load, increased performance may lead to higher latency for non-acceleratable requests due to the additional synchronization. CWC allows developers to significantly increase REST API performance above the current state-of-the-art.</p>
  </div>
</div><br>

**Authors:**
{% for author in site.data.authors.list %}{% if author.orcid %}<a style="border-bottom: none" href="https://orcid.org/{{author.orcid}}">
<img src="assets/ORCIDiD_icon16x16.png" style="width: 1em; margin-inline-start: 0.5em;" alt="ORCID iD icon"/></a>
[{{author.name}}](https://orcid.org/{{author.orcid}}){% else %}{{author.name}}{% endif %}{% if author.name contains "Carle" %}{% else %}, {% endif %}
{% endfor %}


To supplement our paper, we provide the following additional contributions:

- Our [experiment setup]({{ site.baseurl }}{% link _pages/pipeline.md %}) including our proof-of-concept implementation of CRDT Web Caching and the scripts to reproduce our measurements and results
- Our [measurement data]({{ site.baseurl }}{% link _pages/data.md %}) used to generate the plots from the paper
- The [figures]({{ site.baseurl }}{% link _pages/figures.md %}) from the paper as interactive plots.


If you are referring to our work or use our data in your publication, you can use the following:

```bib
{% raw %}@InProceedings{sosnowski2024crdts,
  author    = {Markus Sosnowski and Richard {von Seck} and Florian Wiedner and Georg Carle},
  title     = {{CRDT Web Caching: Enabling Distributed Writes and Fast Cache Consistency for REST APIs}},
  booktitle = {20th International Conference on Network and Service Management (CNSM)},
  address   = {Prague, Czech Republic},
  year      = 2024,
  day       = 28,
  month     = oct,
  doi       = {10.23919/CNSM62983.2024.10814315},
  pdf       = {https://opendl.ifip-tc6.org/db/conf/cnsm/cnsm2024/1571043735.pdf},
}{% endraw %}
```

