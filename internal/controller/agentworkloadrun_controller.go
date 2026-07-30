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

package controller

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	konveyoriov1alpha1 "github.com/konveyor/agentic-controller/api/v1alpha1"
)

const (
	// workloadRunRefIndexField is the field index for looking up
	// AgentWorkloadRuns by workloadRef.
	workloadRunRefIndexField = ".spec.workloadRef"
)

// AgentWorkloadRunReconciler reconciles an AgentWorkloadRun object.
type AgentWorkloadRunReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=konveyor.io,resources=agentworkloadruns,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=konveyor.io,resources=agentworkloadruns/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=konveyor.io,resources=agentworkloadruns/finalizers,verbs=update
// +kubebuilder:rbac:groups=konveyor.io,resources=agentworkloads,verbs=get;list;watch
// +kubebuilder:rbac:groups=konveyor.io,resources=agentruns,verbs=get;list;watch;create

// Reconcile handles AgentWorkloadRun reconciliation.
//
// The controller orchestrates sequential execution of workload stages:
// 1. Looks up the referenced AgentWorkload
// 2. Determines the current stage from status
// 3. Creates an AgentRun for the current stage if none exists
// 4. Watches the AgentRun to completion
// 5. Advances to the next stage or marks the workload run as complete
func (r *AgentWorkloadRunReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var pbRun konveyoriov1alpha1.AgentWorkloadRun
	if err := r.Get(ctx, req.NamespacedName, &pbRun); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	logger.V(1).Info("Reconciling AgentWorkloadRun", "name", pbRun.Name)

	original := pbRun.DeepCopy()
	pbRun.Status.ObservedGeneration = pbRun.Generation

	// If the run is already terminal, nothing to do.
	if pbRun.Status.Phase == konveyoriov1alpha1.AgentRunPhaseSucceeded ||
		pbRun.Status.Phase == konveyoriov1alpha1.AgentRunPhaseFailed {
		return ctrl.Result{}, nil
	}

	// Look up the referenced AgentWorkload.
	var workload konveyoriov1alpha1.AgentWorkload
	workloadKey := types.NamespacedName{Namespace: pbRun.Namespace, Name: pbRun.Spec.WorkloadRef}
	if err := r.Get(ctx, workloadKey, &workload); err != nil {
		if errors.IsNotFound(err) {
			pbRun.Status.Phase = konveyoriov1alpha1.AgentRunPhaseFailed
			now := metav1.Now()
			pbRun.Status.CompletionTime = &now
			meta.SetStatusCondition(&pbRun.Status.Conditions, metav1.Condition{
				Type:               ConditionTypeReady,
				Status:             metav1.ConditionFalse,
				ObservedGeneration: pbRun.Generation,
				Reason:             "WorkloadNotFound",
				Message:            fmt.Sprintf("AgentWorkload %q not found", pbRun.Spec.WorkloadRef),
			})
			return r.patchRunStatus(ctx, &pbRun, original)
		}
		return ctrl.Result{}, err
	}

	// Check that the workload is Ready.
	workloadReady := meta.FindStatusCondition(workload.Status.Conditions, ConditionTypeReady)
	if workloadReady == nil || workloadReady.Status != metav1.ConditionTrue {
		meta.SetStatusCondition(&pbRun.Status.Conditions, metav1.Condition{
			Type:               ConditionTypeReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: pbRun.Generation,
			Reason:             "WorkloadNotReady",
			Message:            fmt.Sprintf("AgentWorkload %q is not Ready", pbRun.Spec.WorkloadRef),
		})
		return r.patchRunStatus(ctx, &pbRun, original)
	}

	// Set start time on first reconcile.
	if pbRun.Status.StartTime == nil {
		now := metav1.Now()
		pbRun.Status.StartTime = &now
		pbRun.Status.Phase = konveyoriov1alpha1.AgentRunPhasePending
	}

	// Initialize stage statuses if empty.
	if len(pbRun.Status.Stages) == 0 {
		pbRun.Status.Stages = make([]konveyoriov1alpha1.AgentWorkloadRunStageStatus, len(workload.Spec.Stages))
		for i, stage := range workload.Spec.Stages {
			pbRun.Status.Stages[i] = konveyoriov1alpha1.AgentWorkloadRunStageStatus{
				Name:  stage.Name,
				Phase: konveyoriov1alpha1.AgentRunPhasePending,
			}
		}
	}

	// Find the current stage to process. Use the snapshotted status
	// stages as the source of truth — the workload could have been
	// modified since the run started, but the run executes the stages
	// that were captured at initialization time.
	stageIndex := r.findCurrentStageIndex(&pbRun)
	if stageIndex >= len(pbRun.Status.Stages) {
		// All stages completed successfully.
		pbRun.Status.Phase = konveyoriov1alpha1.AgentRunPhaseSucceeded
		pbRun.Status.CurrentStage = ""
		now := metav1.Now()
		pbRun.Status.CompletionTime = &now
		meta.SetStatusCondition(&pbRun.Status.Conditions, metav1.Condition{
			Type:               ConditionTypeReady,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: pbRun.Generation,
			Reason:             reasonSucceeded,
			Message:            "All stages completed successfully",
		})
		return r.patchRunStatus(ctx, &pbRun, original)
	}

	// Look up the stage definition from the workload by name
	// (matching the snapshotted status entry).
	stageStatus := &pbRun.Status.Stages[stageIndex]
	var stage *konveyoriov1alpha1.AgentWorkloadStage
	for i := range workload.Spec.Stages {
		if workload.Spec.Stages[i].Name == stageStatus.Name {
			stage = &workload.Spec.Stages[i]
			break
		}
	}
	if stage == nil {
		// The workload was modified and no longer has this stage.
		pbRun.Status.Phase = konveyoriov1alpha1.AgentRunPhaseFailed
		now := metav1.Now()
		pbRun.Status.CompletionTime = &now
		meta.SetStatusCondition(&pbRun.Status.Conditions, metav1.Condition{
			Type:               ConditionTypeReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: pbRun.Generation,
			Reason:             "StageNotFound",
			Message:            fmt.Sprintf("Stage %q no longer exists in AgentWorkload %q", stageStatus.Name, pbRun.Spec.WorkloadRef),
		})
		return r.patchRunStatus(ctx, &pbRun, original)
	}

	pbRun.Status.CurrentStage = stage.Name
	pbRun.Status.Phase = konveyoriov1alpha1.AgentRunPhaseRunning

	// If no AgentRun exists for this stage, create one.
	if stageStatus.AgentRunName == "" {
		agentRunName, err := r.createAgentRunForStage(ctx, &pbRun, &workload, stage)
		if err != nil {
			logger.Error(err, "Failed to create AgentRun for stage",
				"stage", stage.Name)
			meta.SetStatusCondition(&pbRun.Status.Conditions, metav1.Condition{
				Type:               ConditionTypeReady,
				Status:             metav1.ConditionFalse,
				ObservedGeneration: pbRun.Generation,
				Reason:             "AgentRunCreationFailed",
				Message:            fmt.Sprintf("Failed to create AgentRun for stage %q: %v", stage.Name, err),
			})
			if _, patchErr := r.patchRunStatus(ctx, &pbRun, original); patchErr != nil {
				return ctrl.Result{}, patchErr
			}
			return ctrl.Result{}, err
		}
		stageStatus.AgentRunName = agentRunName
		stageStatus.Phase = konveyoriov1alpha1.AgentRunPhasePending
		meta.SetStatusCondition(&pbRun.Status.Conditions, metav1.Condition{
			Type:               ConditionTypeReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: pbRun.Generation,
			Reason:             "StageRunning",
			Message:            fmt.Sprintf("Stage %q: AgentRun %q created", stage.Name, agentRunName),
		})
		return r.patchRunStatus(ctx, &pbRun, original)
	}

	// An AgentRun exists for this stage — check its status.
	var agentRun konveyoriov1alpha1.AgentRun
	agentRunKey := types.NamespacedName{Namespace: pbRun.Namespace, Name: stageStatus.AgentRunName}
	if err := r.Get(ctx, agentRunKey, &agentRun); err != nil {
		if errors.IsNotFound(err) {
			// The AgentRun was deleted externally — fail the stage.
			stageStatus.Phase = konveyoriov1alpha1.AgentRunPhaseFailed
			pbRun.Status.Phase = konveyoriov1alpha1.AgentRunPhaseFailed
			now := metav1.Now()
			pbRun.Status.CompletionTime = &now
			meta.SetStatusCondition(&pbRun.Status.Conditions, metav1.Condition{
				Type:               ConditionTypeReady,
				Status:             metav1.ConditionFalse,
				ObservedGeneration: pbRun.Generation,
				Reason:             "AgentRunDeleted",
				Message:            fmt.Sprintf("Stage %q: AgentRun %q was deleted", stage.Name, stageStatus.AgentRunName),
			})
			return r.patchRunStatus(ctx, &pbRun, original)
		}
		return ctrl.Result{}, err
	}

	// Mirror the AgentRun's phase onto the stage status.
	stageStatus.Phase = agentRun.Status.Phase

	switch agentRun.Status.Phase {
	case konveyoriov1alpha1.AgentRunPhaseSucceeded:
		// Stage completed — the next reconcile will advance to the next stage.
		meta.SetStatusCondition(&pbRun.Status.Conditions, metav1.Condition{
			Type:               ConditionTypeReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: pbRun.Generation,
			Reason:             "StageSucceeded",
			Message:            fmt.Sprintf("Stage %q completed successfully", stage.Name),
		})
		return r.patchRunStatus(ctx, &pbRun, original)

	case konveyoriov1alpha1.AgentRunPhaseFailed:
		// Stage failed — fail the entire workload run.
		pbRun.Status.Phase = konveyoriov1alpha1.AgentRunPhaseFailed
		now := metav1.Now()
		pbRun.Status.CompletionTime = &now
		meta.SetStatusCondition(&pbRun.Status.Conditions, metav1.Condition{
			Type:               ConditionTypeReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: pbRun.Generation,
			Reason:             "StageFailed",
			Message:            fmt.Sprintf("Stage %q failed", stage.Name),
		})
		return r.patchRunStatus(ctx, &pbRun, original)

	default:
		// Stage is still running (Pending or Running).
		meta.SetStatusCondition(&pbRun.Status.Conditions, metav1.Condition{
			Type:               ConditionTypeReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: pbRun.Generation,
			Reason:             "StageRunning",
			Message:            fmt.Sprintf("Stage %q is %s", stage.Name, agentRun.Status.Phase),
		})
		return r.patchRunStatus(ctx, &pbRun, original)
	}
}

// findCurrentStageIndex returns the index of the first stage that has not
// yet succeeded. Returns len(stages) if all stages have succeeded.
func (r *AgentWorkloadRunReconciler) findCurrentStageIndex(
	pbRun *konveyoriov1alpha1.AgentWorkloadRun,
) int {
	for i, stage := range pbRun.Status.Stages {
		if stage.Phase != konveyoriov1alpha1.AgentRunPhaseSucceeded {
			return i
		}
	}
	return len(pbRun.Status.Stages)
}

// stageAgentRunName returns the deterministic name for a stage's AgentRun.
// Follows the Tekton pattern: <parent>-<child>, truncated to 63 chars
// with a hash suffix to avoid collisions.
func stageAgentRunName(pbRunName, stageName string) string {
	return sanitizeVolumeName(pbRunName + "-" + stageName)
}

// createAgentRunForStage creates an AgentRun for the given workload stage.
// It forwards params, models, env, and envFrom from the workload run spec.
// Workload-level instructions (Guide) are passed as a separate env var
// so the harness can present them alongside stage instructions without
// the controller making prompt composition decisions.
//
// Uses a deterministic name (<workloadrun>-<stage>) so that duplicate
// creation on status-patch conflict is caught by AlreadyExists.
func (r *AgentWorkloadRunReconciler) createAgentRunForStage(
	ctx context.Context,
	pbRun *konveyoriov1alpha1.AgentWorkloadRun,
	workload *konveyoriov1alpha1.AgentWorkload,
	stage *konveyoriov1alpha1.AgentWorkloadStage,
) (string, error) {
	agentRunName := stageAgentRunName(pbRun.Name, stage.Name)

	// Pass workload-level instructions (Guide) as an env var.
	// The harness decides how to compose this with the Agent prompt
	// and stage instructions.
	var env []corev1.EnvVar
	if workload.Spec.Guide != "" {
		env = append(env, corev1.EnvVar{
			Name:  "KONVEYOR_WORKLOAD_INSTRUCTIONS",
			Value: workload.Spec.Guide,
		})
	}
	env = append(env, pbRun.Spec.Env...)

	agentRun := &konveyoriov1alpha1.AgentRun{
		ObjectMeta: metav1.ObjectMeta{
			Name:      agentRunName,
			Namespace: pbRun.Namespace,
			Labels: map[string]string{
				labelManagedBy:        managedByLabel,
				labelAgentWorkloadRun: pbRun.Name,
				labelStage:            stage.Name,
			},
		},
		Spec: konveyoriov1alpha1.AgentRunSpec{
			AgentRef:     stage.AgentRef,
			Instructions: stage.Instructions,
			Models:       pbRun.Spec.Models,
			Params:       pbRun.Spec.Params,
			Env:          env,
			EnvFrom:      pbRun.Spec.EnvFrom,
		},
	}

	if err := ctrl.SetControllerReference(pbRun, agentRun, r.Scheme); err != nil {
		return "", fmt.Errorf("setting AgentRun owner reference: %w", err)
	}

	if err := r.Create(ctx, agentRun); err != nil {
		if errors.IsAlreadyExists(err) {
			// AgentRun was likely created on a prior reconcile but the
			// status patch failed. Verify it belongs to this workload
			// run before accepting it.
			var existing konveyoriov1alpha1.AgentRun
			if getErr := r.Get(ctx, types.NamespacedName{
				Name: agentRunName, Namespace: pbRun.Namespace,
			}, &existing); getErr != nil {
				return "", fmt.Errorf("fetching existing AgentRun %q: %w", agentRunName, getErr)
			}
			if !isOwnedBy(&existing, pbRun) {
				return "", fmt.Errorf("AgentRun %q already exists but is not owned by this workload run", agentRunName)
			}
			return agentRunName, nil
		}
		return "", fmt.Errorf("creating AgentRun for stage %q: %w", stage.Name, err)
	}

	return agentRunName, nil
}

// isOwnedBy checks whether the child resource has a controller owner
// reference pointing to the expected parent.
func isOwnedBy(child client.Object, parent client.Object) bool {
	for _, ref := range child.GetOwnerReferences() {
		if ref.Controller != nil && *ref.Controller && ref.UID == parent.GetUID() {
			return true
		}
	}
	return false
}

// patchRunStatus patches the AgentWorkloadRun status.
func (r *AgentWorkloadRunReconciler) patchRunStatus(
	ctx context.Context,
	pbRun *konveyoriov1alpha1.AgentWorkloadRun,
	original *konveyoriov1alpha1.AgentWorkloadRun,
) (ctrl.Result, error) {
	if err := r.Status().Patch(ctx, pbRun, client.MergeFrom(original)); err != nil {
		log.FromContext(ctx).Error(err, "Failed to patch AgentWorkloadRun status",
			"agentWorkloadRun", pbRun.Name)
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *AgentWorkloadRunReconciler) SetupWithManager(mgr ctrl.Manager) error {
	// Index AgentWorkloadRuns by workloadRef for efficient reverse lookup
	// when an AgentWorkload changes.
	if err := mgr.GetFieldIndexer().IndexField(
		context.Background(),
		&konveyoriov1alpha1.AgentWorkloadRun{},
		workloadRunRefIndexField,
		func(obj client.Object) []string {
			pbRun := obj.(*konveyoriov1alpha1.AgentWorkloadRun)
			return []string{pbRun.Spec.WorkloadRef}
		},
	); err != nil {
		return fmt.Errorf("indexing %s: %w", workloadRunRefIndexField, err)
	}

	return ctrl.NewControllerManagedBy(mgr).
		For(&konveyoriov1alpha1.AgentWorkloadRun{}).
		Owns(&konveyoriov1alpha1.AgentRun{}).
		Watches(
			&konveyoriov1alpha1.AgentWorkload{},
			handler.EnqueueRequestsFromMapFunc(r.findRunsForWorkload),
		).
		Named("agentworkloadrun").
		Complete(r)
}

// findRunsForWorkload returns reconcile requests for all non-terminal
// AgentWorkloadRuns that reference the given AgentWorkload.
func (r *AgentWorkloadRunReconciler) findRunsForWorkload(
	ctx context.Context,
	obj client.Object,
) []reconcile.Request {
	workload, ok := obj.(*konveyoriov1alpha1.AgentWorkload)
	if !ok {
		return nil
	}

	var runList konveyoriov1alpha1.AgentWorkloadRunList
	if err := r.List(ctx, &runList,
		client.InNamespace(workload.Namespace),
		client.MatchingFields{workloadRunRefIndexField: workload.Name},
	); err != nil {
		log.FromContext(ctx).Error(err, "Failed to list AgentWorkloadRuns for AgentWorkload",
			"workload", workload.Name)
		return nil
	}

	var requests []reconcile.Request
	for _, run := range runList.Items {
		// Only re-reconcile non-terminal runs.
		if run.Status.Phase == konveyoriov1alpha1.AgentRunPhaseSucceeded ||
			run.Status.Phase == konveyoriov1alpha1.AgentRunPhaseFailed {
			continue
		}
		requests = append(requests, reconcile.Request{
			NamespacedName: types.NamespacedName{
				Namespace: run.Namespace,
				Name:      run.Name,
			},
		})
	}

	return requests
}
