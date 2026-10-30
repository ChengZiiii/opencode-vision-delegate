## MODIFIED Requirements

### Requirement: VT-5: Endpoint and credentials resolve for the tool call

**Requirement:** The tool `SHALL` resolve the vision provider's base URL in
this order: (1) `provider.<id>.options.baseURL` from config, (2) an endpoint
from the provider's environment variables when the catalog declares them
(e.g. `MINIMAX_API_HOST`), (3) the provider's catalog `api` field, else a
built-in map of known vision endpoints (minimax family maps to the
Anthropic-style URL), (4) otherwise a clear error. The API key `SHALL`
resolve in this order: (1) the provider's `auth.json` entry (type `api`),
(2) `provider.<id>.options.apiKey` from config (both `provider` and legacy
`providers` sections, provider id matched case-insensitively), (3) the
provider's declared environment variables; auth resolution `SHALL` honor
`OPENCODE_DATA_DIR`/`OPENCODE_AUTH_CONTENT` overrides. For providers
OTHER than the opencode Zen gateway, a key `SHALL` be required: when none
resolves, the tool `SHALL` return a `provider error` naming the fix
(including the config option) and no request is made. For the opencode Zen
gateway (provider id `opencode`, matched case-insensitively), the key
`SHALL` be optional: when none resolves, the request `SHALL` be sent
WITHOUT an `Authorization` (OpenAI shape) or `x-api-key` (Anthropic shape)
header; when a key DOES resolve, it `SHALL` be used normally. The request
`SHALL` use either the OpenAI-compatible `/chat/completions` shape (image
parts as `data:` base64 URLs, `Bearer` auth) or the Anthropic-style
`/messages` shape (image parts as base64 content blocks, `x-api-key`),
selected by the resolved endpoint URL: endpoints whose URL contains
`/anthropic` `SHALL` use the Anthropic shape, all others the OpenAI shape.
The shape split is required because some vision endpoints (e.g.
`api.minimaxi.com`) drop `data:` `image_url` parts on their
OpenAI-compatible endpoint while their Anthropic-style endpoint delivers
them (verified during the upstream spike). Image bytes `SHALL` never be
passed through shell commands — files are read via Node fs APIs only. When
resolution or the request fails, the error `SHALL` be descriptive enough
for the skill's fallback (VT-4) and for the user.

#### Scenario: Config baseURL wins

Given `provider.<id>.options.baseURL` is set to a custom endpoint,
when the tool resolves the endpoint,
then that base URL is used.

#### Scenario: Config apiKey resolves for a custom provider

Given a provider with `provider.<id>.options.apiKey` set in config and no
`auth.json` entry and no provider env key,
when the tool resolves credentials,
then that key is used (e.g. as `Authorization: Bearer <key>` on an
OpenAI-shape request).

#### Scenario: auth.json wins over config apiKey

Given a provider that has BOTH an `auth.json` entry (type `api`) and
`provider.<id>.options.apiKey` set in config,
when the tool resolves credentials,
then the auth.json key is used.

#### Scenario: Known provider default

Given a provider in the built-in endpoint map and no config/env override,
when the tool resolves the endpoint,
then the mapped default is used.

#### Scenario: Anthropic-style endpoint uses the /messages shape

Given a resolved base URL of `https://api.minimaxi.com/anthropic/v1`,
when the tool builds the request,
then the request is an Anthropic-style POST to `<base>/messages` with
base64 image content blocks and an `x-api-key` header.

#### Scenario: OpenAI-compatible endpoint uses the chat/completions shape

Given a resolved base URL without an Anthropic marker,
when the tool builds the request,
then the request is an OpenAI-compatible POST to `<base>/chat/completions`
with `data:` base64 `image_url` parts and a `Bearer` Authorization header.

#### Scenario: Unresolvable endpoint errors

Given a provider with no config baseURL, no env host, no catalog `api`
field, and no map entry,
when the tool resolves the endpoint,
then it returns a descriptive `provider error` and no request is made.

#### Scenario: Non-Zen provider without a key still errors

Given a non-Zen provider (e.g. `minimax-cn-coding-plan`) with no
`auth.json` entry, no config `options.apiKey`, and no provider env key,
when the tool resolves credentials,
then it returns a `provider error` naming the authentication fix and no
request is made (pre-change behavior preserved).

#### Scenario: Zen free model works with no key

Given `agent["vision-agent"].model = "opencode/space-bunny-free"` with no
`auth.json` entry for `opencode` and `OPENCODE_API_KEY` unset,
when `vision_analyze` executes,
then the request is sent to `https://opencode.ai/zen/v1/chat/completions`
WITHOUT an `Authorization` header and the free model's response is parsed
normally.

#### Scenario: Zen with a configured key still authenticates

Given the `opencode` provider has an `auth.json` entry (type `api`),
when the tool resolves credentials for a Zen model,
then the request carries the normal `Authorization: Bearer <key>` header.

#### Scenario: Zen provider id matches case-insensitively

Given a catalog/config provider id of `OpenCode`,
when keyless allowance is evaluated,
then it matches the Zen gateway provider id `opencode` case-insensitively.
