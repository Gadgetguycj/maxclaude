# maxclaude web hub

The hub provides the browser interface and the authenticated agent tunnel. Set `AGENT_SECRET` before starting it.

The defaults bind to loopback on port `8080` and store data in `/data`. Set `HOST`, `PORT`, and `DATA_DIR` for another environment.

The hub creates an argon2id password record on first start. Set `OPERATOR_PASSWORD` to choose that initial password. Keep the interface private by binding to loopback or a VPN interface, or by using an authentication proxy.
