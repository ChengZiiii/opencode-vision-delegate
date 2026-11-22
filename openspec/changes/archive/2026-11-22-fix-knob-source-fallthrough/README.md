# fix-knob-source-fallthrough

v2 knob resolution must fall through when the agent-domain record is present but carries no usable knobs (2.3.2 probe ground truth: ctx.agent.get('vision-agent') returns a model-less record, which short-circuited the config-file fallback and produced the tier-1 'model not configured' error in production)
