# Bloom — Content Spec (frozen before schema/seed work)

This is the source of truth for the domain model. Schema, seed loaders, and tests are all
generated against this file — if it changes, regenerate seed JSON from here, not the other
way around.

Grain: `Subject → Topic → Subtopic → Concept`. Mastery lives at **subtopic** grain. Weights
are siblings-sum-to-1.0 within their parent at every level. Prerequisite edges exist at both
topic and subtopic level.

---

## Subjects

| id | name | grade |
|---|---|---|
| `dsa` | Data Structures & Algorithms | demo-grade |
| `cn` | Computer Networks | catalog-grade |
| `rdbms` | Relational Databases | catalog-grade |
| `oop` | Object-Oriented Programming | catalog-grade |

---

## DSA — 6 topics, 25 subtopics

Topic weights (siblings sum to 1.0 within `dsa`): `arrays .14` · `linked_lists .10` ·
`stacks_queues .12` · `trees .20` · `graphs .22` · `dynamic_programming .22`

Topic-level prerequisite DAG:
```
arrays → linked_lists
arrays → stacks_queues
linked_lists → trees
stacks_queues → trees
trees → graphs
stacks_queues → graphs
arrays → dynamic_programming
```

### Topic: `arrays` (weight .14, difficulty 2, est_hours 4)

| subtopic id | name | weight | diff | hours | concepts | subtopic prereqs |
|---|---|---|---|---|---|---|
| `arr_traversal` | Traversal | .15 | 1 | 1.5 | `iteration_patterns`, `index_bounds` | — |
| `arr_prefix_sum` | Prefix Sum | .20 | 2 | 2.0 | `cumulative_sum`, `range_query` | `arr_traversal` |
| `arr_two_pointer` | Two Pointer | .20 | 2 | 2.0 | `pointer_convergence`, `sorted_array_exploitation` | `arr_traversal` |
| `arr_sliding_window` | Sliding Window | .20 | 3 | 2.5 | `window_expansion_contraction`, `invariant_maintenance` | `arr_two_pointer` |
| `arr_binary_search` | Binary Search | .25 | 3 | 2.5 | `boundary_conditions`, `monotonic_predicate`, `search_space_reduction` | `arr_traversal` |

### Topic: `linked_lists` (weight .10, difficulty 2, est_hours 3.5) — topic prereq: `arrays`

| subtopic id | name | weight | diff | hours | concepts | subtopic prereqs |
|---|---|---|---|---|---|---|
| `ll_singly` | Singly Linked Lists | .30 | 1 | 1.5 | `pointer_manipulation`, `node_traversal` | `arr_traversal` |
| `ll_doubly` | Doubly Linked Lists | .20 | 2 | 1.5 | `bidirectional_links`, `sentinel_nodes` | `ll_singly` |
| `ll_cycle_detection` | Cycle Detection | .25 | 3 | 2.0 | `fast_slow_pointers`, `cycle_proof` | `ll_singly` |
| `ll_reversal` | Reversal | .25 | 2 | 1.5 | `in_place_reversal`, `recursive_vs_iterative` | `ll_singly` |

### Topic: `stacks_queues` (weight .12, difficulty 2, est_hours 6) — topic prereq: `arrays`

| subtopic id | name | weight | diff | hours | concepts | subtopic prereqs |
|---|---|---|---|---|---|---|
| `sq_stack_ops` | Stack Operations | .30 | 1 | 1.5 | `lifo_ordering`, `bracket_matching` | `arr_traversal` |
| `sq_monotonic_stack` | Monotonic Stack | .40 | 4 | 2.5 | `monotonic_invariant`, `next_greater_element` | `sq_stack_ops` |
| `sq_queue_deque` | Queue & Deque | .30 | 2 | 2.0 | `fifo_ordering`, `sliding_window_maximum` | `sq_stack_ops` |

### Topic: `trees` (weight .20, difficulty 3, est_hours 8.5) — topic prereq: `linked_lists`, `stacks_queues`

| subtopic id | name | weight | diff | hours | concepts | subtopic prereqs |
|---|---|---|---|---|---|---|
| `tr_traversal` | Traversal | .25 | 2 | 2.0 | `preorder_inorder_postorder`, `recursive_traversal`, `iterative_traversal_with_stack` | `ll_singly`, `sq_stack_ops` |
| `tr_bst` | Binary Search Trees | .30 | 3 | 2.5 | `bst_invariant`, `insert_delete_balance_intuition` | `tr_traversal` |
| `tr_height_depth` | Height & Depth | .20 | 2 | 1.5 | `recursive_height_computation`, `balance_checking` | `tr_traversal` |
| `tr_lca` | Lowest Common Ancestor | .25 | 4 | 2.5 | `ancestor_path`, `recursive_lca`, `binary_lifting_intuition` | `tr_traversal`, `tr_bst` |

### Topic: `graphs` (weight .22, difficulty 3, est_hours 10.5) — topic prereq: `trees`, `stacks_queues`

| subtopic id | name | weight | diff | hours | concepts | subtopic prereqs |
|---|---|---|---|---|---|---|
| `gr_representation` | Representation | .10 | 1 | 1.5 | `adjacency_list`, `adjacency_matrix`, `representation_tradeoffs` | `tr_traversal` |
| `gr_bfs` | BFS | .25 | 2 | 2.0 | `level_order_exploration`, `visited_tracking`, `queue_based_bfs` | `gr_representation`, `sq_queue_deque` |
| `gr_dfs` | DFS | .20 | 2 | 2.0 | `recursive_dfs`, `stack_based_dfs`, `backtracking` | `gr_representation`, `sq_stack_ops` |
| `gr_topo_sort` | Topological Sort | .20 | 3 | 2.0 | `kahns_algorithm`, `dfs_based_ordering`, `cycle_detection_directed` | `gr_dfs` |
| `gr_shortest_path` | Shortest Path | .25 | 4 | 3.0 | `dijkstra`, `bellman_ford_intuition`, `edge_relaxation` | `gr_bfs`, `gr_topo_sort` |

### Topic: `dynamic_programming` (weight .22, difficulty 4, est_hours 10.5) — topic prereq: `arrays`

| subtopic id | name | weight | diff | hours | concepts | subtopic prereqs |
|---|---|---|---|---|---|---|
| `dp_memoization` | Memoization | .25 | 3 | 2.5 | `overlapping_subproblems`, `top_down_recursion`, `state_definition` | `arr_traversal` |
| `dp_tabulation` | Tabulation | .25 | 3 | 2.5 | `bottom_up_construction`, `state_transition`, `base_case_design` | `dp_memoization` |
| `dp_knapsack` | Knapsack | .25 | 4 | 3.0 | `choice_vs_no_choice`, `weight_capacity_state`, `0_1_vs_unbounded` | `dp_tabulation` |
| `dp_lis` | Longest Increasing Subsequence | .25 | 4 | 2.5 | `subsequence_state`, `binary_search_optimization`, `n_squared_vs_n_log_n` | `dp_tabulation` |

**DSA total: 25 subtopics, ~70 concept tags, 18 subtopic-level prerequisite edges + 7 topic-level edges = 25 edges.**

---

## Computer Networks — 2 topics, 6 subtopics (catalog-grade, unreviewed)

Topic weights: `cn_fundamentals .55` · `cn_routing_app .45`. Topic prereq: `cn_fundamentals → cn_routing_app`.

### Topic: `cn_fundamentals` — OSI & TCP/IP Fundamentals

| subtopic id | name | weight | diff | hours | concepts |
|---|---|---|---|---|---|
| `cn_osi_layers` | OSI 7-Layer Model | .35 | 1 | 2.0 | `layer_responsibilities`, `encapsulation` |
| `cn_tcp_udp` | TCP vs UDP | .35 | 2 | 2.0 | `three_way_handshake`, `reliability_vs_speed`, `flow_control` |
| `cn_ip_addressing` | IP Addressing & Subnetting | .30 | 3 | 2.5 | `subnet_masking`, `cidr_notation`, `address_classes` |

### Topic: `cn_routing_app` — Routing & Application Layer

| subtopic id | name | weight | diff | hours | concepts | prereq |
|---|---|---|---|---|---|---|
| `cn_routing_algorithms` | Routing Algorithms | .35 | 3 | 2.5 | `distance_vector`, `link_state`, `shortest_path_routing` | `cn_ip_addressing` |
| `cn_dns_http` | DNS & HTTP | .35 | 2 | 2.0 | `dns_resolution`, `http_methods`, `statelessness` | `cn_osi_layers` |
| `cn_congestion_control` | Congestion Control | .30 | 4 | 2.5 | `slow_start`, `congestion_avoidance`, `window_scaling` | `cn_tcp_udp` |

---

## RDBMS — 2 topics, 6 subtopics (catalog-grade, unreviewed)

Topic weights: `rdbms_relational_sql .55` · `rdbms_norm_txn .45`. Topic prereq: `rdbms_relational_sql → rdbms_norm_txn`.

### Topic: `rdbms_relational_sql` — Relational Model & SQL

| subtopic id | name | weight | diff | hours | concepts |
|---|---|---|---|---|---|
| `rdbms_er_modeling` | ER Modeling | .30 | 2 | 2.0 | `entity_relationship_diagrams`, `cardinality` |
| `rdbms_sql_queries` | SQL Queries | .40 | 2 | 2.5 | `joins`, `aggregation`, `subqueries` |
| `rdbms_keys_constraints` | Keys & Constraints | .30 | 2 | 2.0 | `primary_foreign_keys`, `referential_integrity` |

### Topic: `rdbms_norm_txn` — Normalization & Transactions

| subtopic id | name | weight | diff | hours | concepts | prereq |
|---|---|---|---|---|---|---|
| `rdbms_normalization` | Normalization | .40 | 3 | 2.5 | `functional_dependency`, `1nf_2nf_3nf`, `bcnf` | `rdbms_er_modeling` |
| `rdbms_transactions_acid` | Transactions & ACID | .30 | 3 | 2.0 | `acid_properties`, `isolation_levels` | `rdbms_sql_queries` |
| `rdbms_indexing` | Indexing | .30 | 4 | 2.5 | `b_tree_index`, `index_selectivity`, `query_planning` | `rdbms_keys_constraints` |

---

## OOP — 2 topics, 6 subtopics (catalog-grade, unreviewed)

Topic weights: `oop_core .50` · `oop_design .50`. Topic prereq: `oop_core → oop_design`.

### Topic: `oop_core` — Core Principles

| subtopic id | name | weight | diff | hours | concepts |
|---|---|---|---|---|---|
| `oop_encapsulation_abstraction` | Encapsulation & Abstraction | .30 | 1 | 1.5 | `access_modifiers`, `information_hiding` |
| `oop_inheritance` | Inheritance | .35 | 2 | 2.0 | `is_a_relationship`, `method_overriding`, `super_calls` |
| `oop_polymorphism` | Polymorphism | .35 | 3 | 2.0 | `compile_time_vs_runtime`, `virtual_dispatch` |

### Topic: `oop_design` — Design & Patterns

| subtopic id | name | weight | diff | hours | concepts | prereq |
|---|---|---|---|---|---|---|
| `oop_solid_principles` | SOLID Principles | .35 | 3 | 2.5 | `single_responsibility`, `open_closed`, `dependency_inversion` | `oop_encapsulation_abstraction` |
| `oop_composition_vs_inheritance` | Composition vs Inheritance | .30 | 3 | 2.0 | `has_a_relationship`, `favor_composition` | `oop_inheritance` |
| `oop_common_design_patterns` | Common Design Patterns | .35 | 4 | 2.5 | `singleton`, `factory`, `observer` | `oop_polymorphism` |

---

## Totals

| | count |
|---|---|
| Subjects | 4 |
| Topics | 12 (6 DSA + 2×3 others) |
| Subtopics | 43 (25 DSA + 18 others) |
| Prerequisite edges | ~43 (25 DSA + 6 per other subject ×3 + 3 topic-level edges) |
| Concepts | ~110 |

## Student, constraints, calendar (seed target)

- 1 student, `sim_now = 2026-11-01T08:00:00Z`
- Constraints: weekday evenings 18:00–20:00 (2h), weekends 10:00–13:00 (3h), effective from account creation
- 12 external calendar events across two weeks: 6 lectures, 4 lab sessions, 2 personal/family blocks

## Resources & questions

Targets and sourcing rules are in `bloom-architecture-plan.md` §17 build brief (this session) —
~120 DSA / ~20 per other subject resources, all hand-collected or LLM-suggested-then-verified
via `verifyUrl.ts`; ~580 reviewed DSA questions + unreviewed CN/RDBMS/OOP questions, generated
via `scripts/generate-questions.ts` and reviewed before touching the database. Phase 1 ships an
initial verified batch sufficient to pass the seed test suite (§8 of the brief); scaling to full
target volume is a content task that continues in parallel with later phases, gated only by
`reviewed = true` never being set without an actual human skim of the answer key.
