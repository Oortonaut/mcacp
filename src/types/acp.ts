// =============================================================================
// Agent Client Protocol (ACP) - TypeScript Type Definitions
// =============================================================================

// Core Scalar Types
/** Unique identifier for an ACP session. */
export type SessionId = string;

/** Protocol version expressed as a uint16 value. */
export type ProtocolVersion = number;

/** Identifier for a JSON-RPC request. */
export type RequestId = string | number | null;

/** Unique identifier for a tool call within a session. */
export type ToolCallId = string;

/** Unique identifier for a terminal instance within a session. */
export type TerminalId = string;

/** Identifier for a session mode. */
export type SessionModeId = string;

/** Role of a participant in the conversation. */
export type Role = 'user' | 'assistant';

// -----------------------------------------------------------------------------
// Initialize
// -----------------------------------------------------------------------------

/** Parameters sent by the client to initialize the ACP connection. */
export interface InitializeParams {
  protocolVersion: ProtocolVersion;
  clientCapabilities: ClientCapabilities;
  clientInfo?: Implementation;
}

/** Result returned by the agent after initialization. */
export interface InitializeResult {
  protocolVersion: ProtocolVersion;
  agentCapabilities: AgentCapabilities;
  agentInfo?: Implementation;
  authMethods?: AuthMethod[];
}

/** Describes a named software component with version info. */
export interface Implementation {
  name: string;
  version: string;
  title?: string;
}

/** Capabilities the client advertises during initialization. */
export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

/** Capabilities the agent advertises during initialization. */
export interface AgentCapabilities {
  loadSession?: boolean;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  sessionCapabilities?: Record<string, boolean>;
}

/** Describes an authentication method the agent supports. */
export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
}

// -----------------------------------------------------------------------------
// MCP Server Configuration
// -----------------------------------------------------------------------------

export interface McpServerStdio {
  name: string;
  command: string;
  args?: string[];
  env?: EnvVariable[];
}

export interface McpServerHttp {
  type: 'http';
  name: string;
  url: string;
  headers?: HttpHeader[];
}

export interface McpServerSse {
  type: 'sse';
  name: string;
  url: string;
  headers?: HttpHeader[];
}

export type McpServer = McpServerStdio | McpServerHttp | McpServerSse;

export interface EnvVariable {
  name: string;
  value: string;
}

export interface HttpHeader {
  name: string;
  value: string;
}

// -----------------------------------------------------------------------------
// Session Lifecycle
// -----------------------------------------------------------------------------

export interface SessionNewParams {
  cwd: string;
  mcpServers: McpServer[];
}

export interface SessionNewResult {
  sessionId: SessionId;
  modes?: SessionModeState;
}

export interface SessionLoadParams {
  sessionId: SessionId;
  cwd: string;
  mcpServers: McpServer[];
}

export interface SessionLoadResult {
  modes?: SessionModeState;
}

export interface SessionMode {
  id: SessionModeId;
  name: string;
  description?: string;
}

export interface SessionModeState {
  availableModes: SessionMode[];
  currentModeId: SessionModeId;
}

export interface SessionSetModeParams {
  sessionId: SessionId;
  modeId: SessionModeId;
}

export interface SessionCancelParams {
  sessionId: SessionId;
}

// -----------------------------------------------------------------------------
// Content Blocks
// -----------------------------------------------------------------------------

export type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLinkContent
  | ResourceContent;

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface AudioContent {
  type: 'audio';
  data: string;
  mimeType: string;
}

export interface ResourceLinkContent {
  type: 'resource_link';
  uri: string;
  mimeType?: string;
  title?: string;
}

export interface ResourceContent {
  type: 'resource';
  resource: EmbeddedResource;
}

export interface EmbeddedResource {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

// -----------------------------------------------------------------------------
// Prompt
// -----------------------------------------------------------------------------

export interface SessionPromptParams {
  sessionId: SessionId;
  prompt: ContentBlock[];
}

export interface SessionPromptResult {
  stopReason: StopReason;
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

// -----------------------------------------------------------------------------
// Session Updates (agent -> client notifications)
// -----------------------------------------------------------------------------

export interface SessionUpdateNotification {
  sessionId: SessionId;
  update: SessionUpdate;
}

export type SessionUpdate =
  | PlanUpdate
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | UserMessageChunkUpdate
  | ToolCallUpdate
  | ToolCallStatusUpdate
  | AvailableCommandsUpdate
  | CurrentModeUpdate;

export interface PlanUpdate {
  sessionUpdate: 'plan';
  entries: PlanEntry[];
}

export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: ContentBlock;
}

export interface AgentThoughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk';
  content: ContentBlock;
}

export interface UserMessageChunkUpdate {
  sessionUpdate: 'user_message_chunk';
  content: ContentBlock;
}

export interface ToolCallUpdate {
  sessionUpdate: 'tool_call';
  toolCallId: ToolCallId;
  title: string;
  status: ToolCallStatus;
  kind?: ToolKind;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  input?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCallStatusUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: ToolCallId;
  status: ToolCallStatus;
  content?: ToolCallContent[];
}

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export type ToolKind = 'text' | 'command' | 'file_edit' | 'file_create' | 'file_delete' | 'search' | 'other';

export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; diff: Diff };

export interface ToolCallLocation {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface Diff {
  path: string;
  oldText: string;
  newText: string;
}

export interface AvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update';
  commands: string[];
}

export interface CurrentModeUpdate {
  sessionUpdate: 'current_mode_update';
  modeState: SessionModeState;
}

// -----------------------------------------------------------------------------
// Permission (agent -> client request)
// -----------------------------------------------------------------------------

export interface RequestPermissionParams {
  sessionId: SessionId;
  toolCall: ToolCallInfo;
  options: PermissionOption[];
}

export interface ToolCallInfo {
  toolCallId: ToolCallId;
  title: string;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export type RequestPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

// -----------------------------------------------------------------------------
// File System (agent -> client requests)
// -----------------------------------------------------------------------------

export interface FsReadTextFileParams {
  sessionId: SessionId;
  path: string;
  line?: number;
  limit?: number;
}

export interface FsReadTextFileResult {
  content: string;
}

export interface FsWriteTextFileParams {
  sessionId: SessionId;
  path: string;
  content: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FsWriteTextFileResult {}

// -----------------------------------------------------------------------------
// Terminal (agent -> client requests)
// -----------------------------------------------------------------------------

export interface TerminalCreateParams {
  sessionId: SessionId;
  command: string;
  args?: string[];
  cwd?: string;
  env?: EnvVariable[];
  outputByteLimit?: number;
}

export interface TerminalCreateResult {
  terminalId: TerminalId;
}

export interface TerminalOutputParams {
  sessionId: SessionId;
  terminalId: TerminalId;
}

export interface TerminalOutputResult {
  output: string;
  truncated: boolean;
  exitStatus?: TerminalExitStatus;
}

export interface TerminalWaitForExitParams {
  sessionId: SessionId;
  terminalId: TerminalId;
}

export interface TerminalWaitForExitResult {
  exitCode?: number;
  signal?: string;
}

export interface TerminalKillParams {
  sessionId: SessionId;
  terminalId: TerminalId;
}

export interface TerminalReleaseParams {
  sessionId: SessionId;
  terminalId: TerminalId;
}

export interface TerminalExitStatus {
  exitCode?: number;
  signal?: string;
}

// -----------------------------------------------------------------------------
// Error Codes
// -----------------------------------------------------------------------------

export enum AcpErrorCode {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
  AuthenticationRequired = -32000,
  ResourceNotFound = -32002,
}

// -----------------------------------------------------------------------------
// Annotations
// -----------------------------------------------------------------------------

export interface Annotations {
  audience?: ('user' | 'assistant')[];
  priority?: number;
  lastModified?: string;
}

// -----------------------------------------------------------------------------
// JSON-RPC 2.0 Base Types
// -----------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: RequestId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
