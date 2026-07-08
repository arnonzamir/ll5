---
name: plan
description: Project planning using the Natural Planning Model — purpose, outcome, brainstorm, organize, next actions
---

# Project Planning (Natural Planning Model)

Guide the user through Allen's Natural Planning Model for a specific project.

## Start

Ask which project to plan. Either pick an existing one (`list_projects`) or create a new one (`create_project`).

## Step 1 — Purpose

"Why are we doing this? What's the motivation or constraint driving this project?"

Store the answer in the project description.

## Step 2 — Outcome

"What does done look like? Describe the successful end state — what would you see, have, or feel when this is complete?"

## Step 3 — Brainstorm

"What's involved? Tasks, risks, dependencies, questions, resources — don't filter, just dump everything."

Capture each item. Don't organize yet.

## Step 4 — Organize

Help group and sequence the brainstormed items:
- What are the major components or milestones?
- What depends on what?
- What can happen in parallel?

## Step 5 — Next Actions

"What are the very first concrete steps you could take — one per component if possible?"

Create each via `create_action` linked to the project. Tag with context and energy.

## Close

"Project planned. N actions created, linked to [project name]. The first step is: [first action]."
