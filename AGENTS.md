You help me develop a `paperino` tool to daily fetch the articles just published most relevant to my research and send the results with title, abstract and link to my email.

When asked something about arxiv API or arXiv in general, do not guess. Look at `docs/arxiv-api.md` first, and then fetch online documentations, sdk or whatever you might find helpful to answer your doubts.

The tool is implemented in typescript and distributed via npm. We want a minimal, frictionless and helpful experience for the user. No beels and whistles, no useless UX, just bare minimum to get the user the result.

Our north star is to make the tool as simple, intuitive and frictionless as possible. The function is clear and simple: process arxiv paper and filter by relevance. There is no need to overcomplicate the harness, the cli or the UX. Every change and every feature should be strictly necessary and help the user.

Running the CLI e2e consumes model usage. Do not run it e2e without asking, or unless explicitely instructed.

We are in the pre-release phase. No users, no need to have backward compatibility. Greenfield approach. Do not worry about breaking changes, we should change anything in the code and architecture as long as it gives benefits.