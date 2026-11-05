# Page patterns

P0 reserves a single seam for the host page patterns. This directory does not render, inject styles, or register slots.

Later phases implement PageLayout, ListPatterns, EmptyState, RightPanel, SettingsShell, Dialog, StatBar and ToolCard here, using the confirmed frontend plan and actual host primitives. Their props and behavior remain to be derived from the existing consumers during those phases. This skeleton does not implement the host's missing Textarea, Select or other atoms.
