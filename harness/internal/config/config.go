package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

const (
	DefaultMaxTurns = 200
)

type Config struct {
	Model    string
	Provider string
	Endpoint string
	APIKey   string
	MaxTurns int

	HubBaseURL   string
	HubToken     string
	AppID        string
	ACPSecretKey string

	TargetBranch string

	// ACPTee: the harness fronts the pod ACP port and tees the run's
	// live stream to attached viewers (default on; HARNESS_ACP_TEE=off
	// restores goose owning the port directly).
	ACPTee bool
	// HITLTimeout: how long a permission ask waits for an attached
	// viewer before the headless fallback (HARNESS_HITL_TIMEOUT_SECONDS).
	HITLTimeout time.Duration

	// Prompt context layers, composed by internal/prompt.
	AgentPrompt       string
	WorkflowGuide     string
	StageInstructions string
}

func LoadFromEnv() (*Config, error) {
	required := map[string]string{
		"KONVEYOR_MODEL_PRIMARY_MODEL":    os.Getenv("KONVEYOR_MODEL_PRIMARY_MODEL"),
		"KONVEYOR_MODEL_PRIMARY_PROVIDER": os.Getenv("KONVEYOR_MODEL_PRIMARY_PROVIDER"),
		"HUB_BASE_URL":                    os.Getenv("HUB_BASE_URL"),
		"APP_ID":                          os.Getenv("APP_ID"),
		"KONVEYOR_ACP_SECRET_KEY":         os.Getenv("KONVEYOR_ACP_SECRET_KEY"),
		"TARGET_BRANCH":                   os.Getenv("TARGET_BRANCH"),
	}
	for k, v := range required {
		if v == "" {
			return nil, fmt.Errorf("required env var %s is not set", k)
		}
	}

	cfg := &Config{
		Model:        required["KONVEYOR_MODEL_PRIMARY_MODEL"],
		Provider:     required["KONVEYOR_MODEL_PRIMARY_PROVIDER"],
		Endpoint:     os.Getenv("KONVEYOR_MODEL_PRIMARY_ENDPOINT"),
		APIKey:       os.Getenv("KONVEYOR_MODEL_PRIMARY_API_KEY"),
		MaxTurns:     DefaultMaxTurns,
		HubBaseURL:   required["HUB_BASE_URL"],
		HubToken:     os.Getenv("HUB_TOKEN"),
		AppID:        required["APP_ID"],
		ACPSecretKey: required["KONVEYOR_ACP_SECRET_KEY"],
		TargetBranch: required["TARGET_BRANCH"],

		AgentPrompt:       os.Getenv("KONVEYOR_PROMPT"),
		WorkflowGuide:     workflowGuideFromEnv(),
		StageInstructions: os.Getenv("KONVEYOR_INSTRUCTIONS"),
	}

	if n, err := strconv.Atoi(os.Getenv("KONVEYOR_PARAM_MAX_TURNS")); err == nil && n > 0 {
		cfg.MaxTurns = n
	}

	// Default-ON kill switch: the one E2E path must exercise the tee, so
	// only an explicit opt-out disables it.
	switch os.Getenv("HARNESS_ACP_TEE") {
	case "off", "false", "0", "disabled":
		cfg.ACPTee = false
	default:
		cfg.ACPTee = true
	}
	if n, err := strconv.Atoi(os.Getenv("HARNESS_HITL_TIMEOUT_SECONDS")); err == nil && n > 0 {
		cfg.HITLTimeout = time.Duration(n) * time.Second
	}

	return cfg, nil
}

// workflowGuideFromEnv reads the workflow guide the controller injects.
//
// The canonical env var is KONVEYOR_WORKFLOW_GUIDE (set by the controller).
// KONVEYOR_PLAYBOOK_INSTRUCTIONS is the legacy name; drop the fallback
// once all deployed controllers use the new name.
func workflowGuideFromEnv() string {
	if v := os.Getenv("KONVEYOR_WORKFLOW_GUIDE"); v != "" {
		return v
	}
	return os.Getenv("KONVEYOR_PLAYBOOK_INSTRUCTIONS")
}
