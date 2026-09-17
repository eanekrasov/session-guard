# Changelog

## 1.0.0 (2026-09-17)


### Features

* a profile holds several schemas, a session runs one ([e60f70a](https://github.com/eanekrasov/session-guard/commit/e60f70a08ef9bfe2ea97d6971fa0e9943b805476))
* **cli:** add sync-agents command with a structured sync outcome ([e753410](https://github.com/eanekrasov/session-guard/commit/e753410921eef7122471db911c9ce43b94c6cefc))
* **gates:** declare gates in the profile instead of hardcoding them ([f05fb1f](https://github.com/eanekrasov/session-guard/commit/f05fb1f117436792590c5784f8e082666d87a067))
* one funnel for every error the plugin reports ([fdd04f8](https://github.com/eanekrasov/session-guard/commit/fdd04f831309fbb7f02591e2fbb57f4bfdcb9c01))
* the compiler parses every guard and names every key nothing reads ([7f0389c](https://github.com/eanekrasov/session-guard/commit/7f0389c262e0d38bd21a341435e11f66e7f9d581))


### Bug Fixes

* a bash call that only reads is not a move, and the dashboard reads the real store ([6075c3f](https://github.com/eanekrasov/session-guard/commit/6075c3faa1a5ecf839f6b31c8fe5bdbe31668aee))
* a cancelled task stays cancelled, inheritance keeps the grandparent, nested loops run, a missing schema is refused ([c49f167](https://github.com/eanekrasov/session-guard/commit/c49f167b5f0c3bf6c81bd7ff2618e5c22233653c))
* a pair of stages may carry several edges, and merging keeps them ([b22484a](https://github.com/eanekrasov/session-guard/commit/b22484ad41834c8a02ce9f818b68a43933b58500))
* a plugin instance keeps its own paths instead of exporting them ([e7a39da](https://github.com/eanekrasov/session-guard/commit/e7a39da5e24d61a39cc69a05bab3c1fd08e91bbd))
* a running task call is not evidence of an interrupted mutation ([b2889a0](https://github.com/eanekrasov/session-guard/commit/b2889a04102917dbe0f332ba4a90331f529a9b2e))
* a save built on a stale revision is refused, not silently applied ([3e62e99](https://github.com/eanekrasov/session-guard/commit/3e62e99d9d1e7b0954cc2fd624879b425bc49c6c))
* a session starts in its own workflow's first stage ([20db9a3](https://github.com/eanekrasov/session-guard/commit/20db9a35aada1fed8cccd07b8034fdc4185cd265))
* a stage nobody selected has not been left ([6beabc2](https://github.com/eanekrasov/session-guard/commit/6beabc2ed1fb986b15d44d5bd5aa5051fb700c35))
* a stage's roster says whether it edits, a nested task finishes, and a child session may read ([af7703b](https://github.com/eanekrasov/session-guard/commit/af7703b7e8ea31497cd615957835b2e9379037dd))
* a synthesised run starts in the loop's first stage, not a literal ([b8292ea](https://github.com/eanekrasov/session-guard/commit/b8292ea7a752a4f333be75c8d7df2de2c9e3c458))
* a workflow has two retry budgets, and the session may hold both ([37a615c](https://github.com/eanekrasov/session-guard/commit/37a615ced61bf193a42c82fbea7f94fadf6e1f03))
* an edge with no session to check against is refused, not allowed ([184ca0c](https://github.com/eanekrasov/session-guard/commit/184ca0c5d2ba0fc0cfeb00b027981122ac63128d))
* an unrun invariant is not a passed one, and the scope walk goes both ways ([274c92e](https://github.com/eanekrasov/session-guard/commit/274c92e2b11c551a9a30e1f1dec258c50446eadf))
* consent covers every document it named, and only the plan in hand ([0ce081a](https://github.com/eanekrasov/session-guard/commit/0ce081a608457a667f4d2639f8ec30579bf6928b))
* delegated work reaches the delivery permit ([d7f4ff9](https://github.com/eanekrasov/session-guard/commit/d7f4ff954a9e69c0b934795a7266d94287e5518b))
* drop four fallbacks to the base profile's first stage, and stop teaching the wrong names ([b87fa86](https://github.com/eanekrasov/session-guard/commit/b87fa86e6117f86c9ee90ebf240938fc7947c445))
* **engine:** key the engine cache on the directory as well as the id ([9ba3d32](https://github.com/eanekrasov/session-guard/commit/9ba3d32a1dc035f12e0223fd75dc10d0de628ee3))
* five reproduced defects — a symlink escape, a borrowed verdict, a lost context, a blind spot and a writing read ([eb60c2a](https://github.com/eanekrasov/session-guard/commit/eb60c2a941738758e2bd91b6569310d46f6ec553))
* one call, one verdict — a replayed result is refused ([a030d48](https://github.com/eanekrasov/session-guard/commit/a030d4875ddaa9c4d13076ac33c12ee7e2822870))
* remove false-positive eval() and printenv from guardrails ([11f81a4](https://github.com/eanekrasov/session-guard/commit/11f81a41296d7206b39259848394d4db11f0f5d0))
* remove hardcoded 'planning' default from schema and createSession ([86b4c96](https://github.com/eanekrasov/session-guard/commit/86b4c96019fce5f956b2f78865661925a26beb8e))
* **schema:** let the gate check reach production ([b441046](https://github.com/eanekrasov/session-guard/commit/b441046f674a15ec89d8fe1d7b675a68e4cd6e72))
* **schema:** report a nested stage's bad gate once ([ae57e94](https://github.com/eanekrasov/session-guard/commit/ae57e94d380b58822f75fcf60a62e2ae587763ce))
* the base fixture read a fact this project does not have ([eec51bf](https://github.com/eanekrasov/session-guard/commit/eec51bf115dfa55bd70a0fa404ce3a7082041db8))
* the commit step is delivery, not an edit inside a task loop ([a11e254](https://github.com/eanekrasov/session-guard/commit/a11e254681c86848dd41b06a398871df7c98100b))
* the dashboard describes the workflow that is running, not two copies of one ([68f72b4](https://github.com/eanekrasov/session-guard/commit/68f72b412b697804b83c4ecd7fce757c5779ca33))
* the host-smoke deltas inherit base again ([ca972c1](https://github.com/eanekrasov/session-guard/commit/ca972c18301a08245942a758b5a943e2f234aea3))
* the move being judged and the work being delivered are two lists ([ec6bb11](https://github.com/eanekrasov/session-guard/commit/ec6bb114fec76c41ef567695f92d21adc51fbc54))
* the parent chain comes from the host, so delegated work is governed ([28ba4ff](https://github.com/eanekrasov/session-guard/commit/28ba4ff13cce92bb0f030f3cd1c95c7398f9cc2c))
* the permit expects the net change, not every path ever touched ([fb19eb0](https://github.com/eanekrasov/session-guard/commit/fb19eb09feccaa98fbb40f4b1271538f1ffaa6f6))
* the plugin stops sweeping its own generated files into the delivery ([6ed6944](https://github.com/eanekrasov/session-guard/commit/6ed69443e07eb2123c1b06ef4a68294df4e692a4))
* the repository's first commit is verifiable like any other ([2708c27](https://github.com/eanekrasov/session-guard/commit/2708c27f1c2c0da7cee69661a5d07fe6121f02fa))
* the revision check and the write are one step across processes too ([48a86cf](https://github.com/eanekrasov/session-guard/commit/48a86cfe40379eb2733b3439ed84cb1ac8a65c78))
* the workflow says which task list it has ([0f1cc2d](https://github.com/eanekrasov/session-guard/commit/0f1cc2d081b1075aa14e876320e75e90a4bff0c6))
* three cheap fixes from audit ([061676b](https://github.com/eanekrasov/session-guard/commit/061676b2fe809c520e9ad88db3983d8fae5eaf72))
* **tui:** read the session shape the plugin actually writes ([552c104](https://github.com/eanekrasov/session-guard/commit/552c1042f264ec5e25d914916a71d2a19e61d910))

## Changelog

All notable changes to this project will be documented here by Release Please.
