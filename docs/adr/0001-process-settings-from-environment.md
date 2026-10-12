# 1. Process settings come from the environment; routing comes only from the configuration source

Status: accepted

## Context

A gateway has two kinds of setting. Some describe the process: which ports it listens on, where it reads configuration from, who it is, where its secrets are. Others describe traffic: routes, services, plugins. Many gateways let both live in one file, and some let a database override what a file says, so that it is hard to say where a setting in force came from.

## Decision

Process and topology settings are environment variables, read once at start. Everything about routing comes from exactly one configuration source, chosen by `APG_CONFIG_SOURCE`: a file, or the control plane. The two never mix: no routing in the environment, no listen address in `apg.yaml`.

## Consequences

- For any setting there is one place to look.
- The same `apg.yaml` works on every node and in every environment, because nothing in it is about the machine.
- Changing a process setting needs a restart. Changing routing never does.
- A variable that is set but unusable stops the process at start with a message naming it, rather than being ignored.
