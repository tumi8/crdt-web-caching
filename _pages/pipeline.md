---
layout: page
title: "Experiment Setup"
permalink: /experiment/
order: 3
toc: Experiment
description: "To enable reproducible results and help in understanding our approach we have open-sourced our full experiment setup including our proof-of-concept implementation of CRDT Web Caching."
---

The experiment setup can be found [[here]({{ site.github_link }})] or directly via Git:

```bash
git clone {{ site.github_ssh }}
```

<style>
.language-plaintext {
background-color: #f1f1f1;
border: 1px solid #dddddd;
font-size: 85%;
padding: 1pt;
font-family: SFMono-Regular, Consolas, Liberation Mono, Menlo, Courier, monospace
}
</style>

The experiment was automated via [[pos]](https://doi.org/10.1145/3485983.3494841) framework. If you do not have access to something similar, try the following:
1. set up a fresh debian-bullseye VM or baremetal server
2. clone the repository
3. run the `./setup.sh` script (**warning**: running it on you own PC might install unwanted dependencies, better use a VM).
   The setup script will install mininet and other dependencies (npm, node, typescript, mininet, etc.)
4. Run the experiment with `./experiment.sh $OUT_DIR $SCENARIO $CACHING_STRATEGY`.
   
   OUT_DIR is the directory where the results are saved<br>
   SCENARIO is either `flights` or `forums` (details in the paper)<br>
   CACHING_STRATEGY is on of:

  | argument | Caching Strategy           |
  |----------|----------------------------|
  | `crdt`   | CRDT Web Caching           |
  | `cache`  | Invalidation-based Caching |
  | `ttl`    | TTL-based Caching          |
  | `proxy`  | No Caching                 |

**Note:** On our server, the `CPULimitedHost` feature of mininet did not work and we had to switch to the `2.3.1b4` development branch.
