package importer

import (
	"fmt"
	"strings"
)

// Turning a parsed file into the exact set of writes an import will perform.
//
// ── This file handles plaintext secret values ──
//
// Every [PlanItem] carries a decrypted value. A [Plan] must never be logged,
// serialised into an audit record, attached to an error report, or sent anywhere
// other than the environment it was built for. There is no String method on
// purpose: a redacting one would make a plan *look* safe while the value stayed
// one field access away, and would train reviewers to stop noticing that this
// struct is dangerous. It is a plain struct, and it is dangerous.
//
// ── The dry run is the import ──
//
// [BuildPlan] is pure — no I/O, no clock, no randomness. The preview the user
// approves ("42 will be added, 3 overwritten") and the write path that runs
// afterwards call this same function with the same inputs, so the preview cannot
// disagree with what happens. The writer's only job is to execute Items.

// Strategy is what to do with a source key whose target name already exists.
type Strategy string

const (
	StrategySkip      Strategy = "skip"
	StrategyOverwrite Strategy = "overwrite"
	StrategyRename    Strategy = "rename"
)

// KnownStrategy reports whether a string names one.
func KnownStrategy(value string) bool {
	switch Strategy(value) {
	case StrategySkip, StrategyOverwrite, StrategyRename:
		return true
	}
	return false
}

// ItemStatus is what will happen to one source key.
type ItemStatus string

const (
	StatusCreate    ItemStatus = "create"
	StatusOverwrite ItemStatus = "overwrite"
	StatusSkip      ItemStatus = "skip"
	StatusRename    ItemStatus = "rename"
	StatusInvalid   ItemStatus = "invalid"
)

// PlanItem is one planned write.
type PlanItem struct {
	SourceKey string `json:"sourceKey"`
	// TargetName is the normalised, valid secret name. Empty only when Status is
	// StatusInvalid.
	TargetName string `json:"targetName"`
	// Value is plaintext. See the file header.
	Value  string     `json:"-"`
	Status ItemStatus `json:"status"`
	// Note explains an invalid name, a normalisation, or a conflict outcome.
	// Safe to display; it never contains a value.
	Note string `json:"note,omitempty"`
}

// Plan is the whole set.
type Plan struct {
	Items    []PlanItem
	Warnings []Warning
	Counts   map[ItemStatus]int
}

// maxRenameAttempts: a rename appends `_2`, `_3`, …. Reaching this many
// collisions on one name means the source file is pathological, not that the
// scheme needs more room; reporting it beats spinning.
const maxRenameAttempts = 1000

// BuildPlan decides the outcome of every parsed entry.
func BuildPlan(parsed Result, existingNames []string, strategy Strategy) Plan {
	existing := map[string]bool{}
	for _, name := range existingNames {
		existing[name] = true
	}
	// claimed is the set of names this plan has already committed to writing.
	claimed := map[string]bool{}

	items := make([]PlanItem, 0, len(parsed.Entries))
	counts := map[ItemStatus]int{
		StatusCreate: 0, StatusOverwrite: 0, StatusSkip: 0, StatusRename: 0, StatusInvalid: 0,
	}

	for _, entry := range parsed.Entries {
		item := planEntry(entry.Key, entry.Value, existing, claimed, strategy)
		if item.Status != StatusInvalid && item.Status != StatusSkip {
			claimed[item.TargetName] = true
		}
		counts[item.Status]++
		items = append(items, item)
	}

	warnings := parsed.Warnings
	if warnings == nil {
		warnings = []Warning{}
	}
	return Plan{Items: items, Warnings: warnings, Counts: counts}
}

func planEntry(
	sourceKey, value string,
	existing, claimed map[string]bool,
	strategy Strategy,
) PlanItem {
	targetName := NormalizeSecretName(sourceKey)

	if targetName == "" {
		return invalidItem(sourceKey, value, fmt.Sprintf(
			"%q contains no letters, digits or underscores, so it cannot become a secret name.",
			sourceKey))
	}

	if IsReservedSecretName(targetName) {
		return invalidItem(sourceKey, value, fmt.Sprintf(
			"%q is reserved by the operating system. Importing it would change how programs "+
				"launched with these secrets find their executables and libraries.", targetName))
	}

	if problem := CheckSecretName(targetName); problem != "" {
		return invalidItem(sourceKey, value, problem)
	}

	// A key that only changed case or punctuation still changed. Saying so keeps
	// anything from arriving under a name the user did not choose.
	normalised := ""
	if targetName != sourceKey {
		normalised = fmt.Sprintf("%q was normalised to %q.", sourceKey, targetName)
	}

	if claimed[targetName] {
		return planCollision(sourceKey, value, targetName, existing, claimed, strategy)
	}

	if !existing[targetName] {
		return newItem(sourceKey, targetName, value, StatusCreate, normalised)
	}

	switch strategy {
	case StrategyOverwrite:
		return newItem(sourceKey, targetName, value, StatusOverwrite, fmt.Sprintf(
			"%s %q already exists and will be replaced with a new version.", normalised, targetName))
	case StrategyRename:
		return planRename(sourceKey, value, targetName, existing, claimed)
	default:
		return newItem(sourceKey, targetName, value, StatusSkip, fmt.Sprintf(
			"%s %q already exists and was left unchanged.", normalised, targetName))
	}
}

// planCollision handles two different source keys that normalise to one name —
// `my-api-key` and `MY_API_KEY` in the same file, say.
//
// Collapsing them silently would import one value under a name the user believes
// holds the other. Under `rename` the second gets a suffix; otherwise it is
// skipped and the note names the winner, because writing the same name twice in
// one run would make the preview's counts a lie.
//
// First-seen wins. The alternative — last wins, matching the `.env` duplicate
// rule — is no more correct, because these are *different* keys and neither is
// the author's stated intent. What matters is that the discarded one is reported.
func planCollision(
	sourceKey, value, targetName string,
	existing, claimed map[string]bool,
	strategy Strategy,
) PlanItem {
	if strategy == StrategyRename {
		return planRename(sourceKey, value, targetName, existing, claimed)
	}
	return newItem(sourceKey, targetName, value, StatusSkip, fmt.Sprintf(
		"Another key in this file already imports as %q, so %q was skipped.", targetName, sourceKey))
}

func planRename(sourceKey, value, targetName string, existing, claimed map[string]bool) PlanItem {
	for suffix := 2; suffix < maxRenameAttempts; suffix++ {
		candidate := fmt.Sprintf("%s_%d", targetName, suffix)
		if existing[candidate] || claimed[candidate] {
			continue
		}
		// The suffix can push a long name past the column limit, which would
		// fail at the database instead of here.
		if len(candidate) > SecretNameMaxLength {
			return invalidItem(sourceKey, value, fmt.Sprintf(
				"%q already exists and renaming it would exceed the %d character limit.",
				targetName, SecretNameMaxLength))
		}
		return newItem(sourceKey, candidate, value, StatusRename, fmt.Sprintf(
			"%q is already taken, so this will be imported as %q.", targetName, candidate))
	}

	return invalidItem(sourceKey, value, fmt.Sprintf(
		"%q and its first %d numbered variants are all taken.", targetName, maxRenameAttempts))
}

func newItem(sourceKey, targetName, value string, status ItemStatus, note string) PlanItem {
	return PlanItem{
		SourceKey:  sourceKey,
		TargetName: targetName,
		Value:      value,
		Status:     status,
		Note:       strings.TrimSpace(note),
	}
}

func invalidItem(sourceKey, value, note string) PlanItem {
	// The value is carried even for an invalid item: re-reading the file to
	// recover a value the user already gave us is the kind of friction that ends
	// with somebody pasting secrets into a chat window instead.
	return PlanItem{SourceKey: sourceKey, Value: value, Status: StatusInvalid, Note: note}
}
