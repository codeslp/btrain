# Recommended Integration: Token-Efficient MCP Bridge

## Goal Description
Integrate `btrain` and `agentchattr` to create a robust, multi-agent coordination environment. Based on the priorities—staying focused on assigned lanes, strict `btrain` doc conformity, periodic tracking, tracking file locks, and **high token efficiency**—we must enforce strict procedural guardrails without ballooning the system prompt size.

AgentChattr will act as the communication and routing layer, while BTrain remains the source of truth for repository state.

## Proposed Architecture: Single Multiplexed Tool
AgentChattr's MCP bridge allows us to define tools natively. Instead of introducing 4-5 verbose tools that burn context tokens on every turn, we will introduce exactly **ONE highly-compressed MCP tool**: `chat_btrain`.

### 1. Token-Optimized Schema
The `chat_btrain` tool will use a discriminator field (`action`) to collapse all capabilities into one JSON definition, keeping the system prompt overhead under ~150 tokens.
- `action="claim"`: Automatically checks active file locks using `btrain locks`. If locked, rejects the claim locally without spending generation tokens.
- `action="update"`: Condenses the 7 `btrain` requirements (base, preflight, changed, verification, gap, why, review_ask) into a single required object payload. The JSON schema enforces conformity mechanically.
- `action="locks"`: Returns an ultra-compact list of active file locks.
- `action="resolve"`: Resolves the lane.

### 2. Guardrailed Handoffs & Lane Focus
Agents must use the `update` action to pass a handoff. If they fail to provide the 7 required fields, the MCP server rejects the call instantly. This forces them to provide accurate documentation without relying on expensive, open-ended LLM reasoning iterations. The `claim` action enforces file locks by calling `btrain locks` internally.

### 3. Periodic Course Correction via Rules
Instead of a separate `status` tool, we leverage AgentChattr's native **Rules** engine to enforce course correction with zero added tool overhead.
- **Rule**: *"Read`.claude/collab/HANDOFF_*.md` via terminal to re-orient your goal before editing files."*
- This uses the agent's native terminal capabilities (which cost 0 MCP definition overhead) while keeping them tightly focused.
