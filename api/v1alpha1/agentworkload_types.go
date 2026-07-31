/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// AgentWorkloadStage defines one stage in a workload.
// Each stage references an Agent and carries instructions.
type AgentWorkloadStage struct {
	// Name is the stage name, unique within the workload.
	// Must be a valid Kubernetes label value (lowercase alphanumeric,
	// hyphens, dots, max 63 chars) since it is used in labels on
	// child AgentRun resources.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=63
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([a-z0-9\-\.]*[a-z0-9])?$`
	Name string `json:"name"`

	// AgentRef is the name of the Agent CR to execute for this stage.
	// +kubebuilder:validation:MinLength=1
	AgentRef string `json:"agentRef"`

	// Instructions are task-specific instructions for this stage.
	// Composed with the Agent's prompt at execution time.
	// +optional
	Instructions string `json:"instructions,omitempty"`
}

// AgentWorkloadSpec defines the desired state of an AgentWorkload.
type AgentWorkloadSpec struct {
	// Guide is a high-level guide providing ambient context for all stages.
	// Written as a context file in the workspace so each agent understands
	// where its work fits in the bigger picture.
	// +optional
	Guide string `json:"guide,omitempty"`

	// Stages is the ordered sequence of stages. Each stage references an
	// Agent and carries instructions. Stages execute sequentially, sharing
	// the same target branch. Cross-stage continuity comes from committed
	// handoff files.
	// +kubebuilder:validation:MinItems=1
	// +listType=map
	// +listMapKey=name
	Stages []AgentWorkloadStage `json:"stages"`
}

// AgentWorkloadStatus defines the observed state of an AgentWorkload.
type AgentWorkloadStatus struct {
	// ObservedGeneration is the most recent generation observed by the controller.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Conditions represent the latest available observations of the
	// AgentWorkload's state.
	// +optional
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=aw
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// AgentWorkload is a reusable workload combining a high-level guide with an
// ordered sequence of stages. Each stage references an Agent and carries
// instructions. An AgentWorkload is a template — creating one does not
// execute anything.
type AgentWorkload struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   AgentWorkloadSpec   `json:"spec,omitempty"`
	Status AgentWorkloadStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// AgentWorkloadList contains a list of AgentWorkload.
type AgentWorkloadList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AgentWorkload `json:"items"`
}
