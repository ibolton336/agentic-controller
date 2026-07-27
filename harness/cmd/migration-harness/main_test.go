package main

import "testing"

func TestValidateTargetBranch(t *testing.T) {
	tests := []struct {
		name    string
		target  string
		source  string
		wantErr bool
	}{
		{"valid different branches", "konveyor-migrate-20260727", "main", false},
		{"empty target", "", "main", true},
		{"target equals source", "main", "main", true},
		{"target equals non-default source", "develop", "develop", true},
		{"source empty is fine", "konveyor-migrate", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateTargetBranch(tt.target, tt.source)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateTargetBranch(%q, %q) error = %v, wantErr %v", tt.target, tt.source, err, tt.wantErr)
			}
		})
	}
}
