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
	"strings"

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
	// workloadAgentRefIndexField is the field index for looking up
	// AgentWorkloads by their stages' agentRef values.
	workloadAgentRefIndexField = ".spec.stages.agentRef"
)

// AgentWorkloadReconciler reconciles an AgentWorkload object.
type AgentWorkloadReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=konveyor.io,resources=agentworkloads,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=konveyor.io,resources=agentworkloads/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=konveyor.io,resources=agentworkloads/finalizers,verbs=update

// Reconcile handles AgentWorkload reconciliation.
//
// The controller validates that all Agents referenced by stages exist and
// are Ready, then reports aggregate readiness on the AgentWorkload.
func (r *AgentWorkloadReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var workload konveyoriov1alpha1.AgentWorkload
	if err := r.Get(ctx, req.NamespacedName, &workload); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	logger.V(1).Info("Reconciling AgentWorkload", "name", workload.Name)

	original := workload.DeepCopy()
	workload.Status.ObservedGeneration = workload.Generation

	var notReadyReasons []string

	// Validate that each stage's Agent exists and is Ready.
	for _, stage := range workload.Spec.Stages {
		var agent konveyoriov1alpha1.Agent
		agentKey := types.NamespacedName{Namespace: workload.Namespace, Name: stage.AgentRef}
		if err := r.Get(ctx, agentKey, &agent); err != nil {
			if errors.IsNotFound(err) {
				notReadyReasons = append(notReadyReasons,
					fmt.Sprintf("stage %q: Agent %q not found", stage.Name, stage.AgentRef))
				continue
			}
			return ctrl.Result{}, err
		}

		readyCond := meta.FindStatusCondition(agent.Status.Conditions, ConditionTypeReady)
		if readyCond == nil || readyCond.Status != metav1.ConditionTrue {
			notReadyReasons = append(notReadyReasons,
				fmt.Sprintf("stage %q: Agent %q is not Ready", stage.Name, stage.AgentRef))
		}
	}

	if len(notReadyReasons) == 0 {
		meta.SetStatusCondition(&workload.Status.Conditions, metav1.Condition{
			Type:               ConditionTypeReady,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: workload.Generation,
			Reason:             "AllAgentsReady",
			Message:            "All stage Agents are ready",
		})
	} else {
		meta.SetStatusCondition(&workload.Status.Conditions, metav1.Condition{
			Type:               ConditionTypeReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: workload.Generation,
			Reason:             "AgentsNotReady",
			Message:            strings.Join(notReadyReasons, "; "),
		})
	}

	if err := r.Status().Patch(ctx, &workload, client.MergeFrom(original)); err != nil {
		logger.Error(err, "Failed to patch AgentWorkload status")
		return ctrl.Result{}, err
	}

	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *AgentWorkloadReconciler) SetupWithManager(mgr ctrl.Manager) error {
	// Index AgentWorkloads by their stages' agentRef values for
	// efficient reverse lookup when an Agent changes.
	if err := mgr.GetFieldIndexer().IndexField(
		context.Background(),
		&konveyoriov1alpha1.AgentWorkload{},
		workloadAgentRefIndexField,
		func(obj client.Object) []string {
			workload := obj.(*konveyoriov1alpha1.AgentWorkload)
			refs := make([]string, len(workload.Spec.Stages))
			for i, stage := range workload.Spec.Stages {
				refs[i] = stage.AgentRef
			}
			return refs
		},
	); err != nil {
		return fmt.Errorf("indexing %s: %w", workloadAgentRefIndexField, err)
	}

	return ctrl.NewControllerManagedBy(mgr).
		For(&konveyoriov1alpha1.AgentWorkload{}).
		Watches(
			&konveyoriov1alpha1.Agent{},
			handler.EnqueueRequestsFromMapFunc(r.findWorkloadsForAgent),
		).
		Named("agentworkload").
		Complete(r)
}

// findWorkloadsForAgent returns reconcile requests for all AgentWorkloads
// that reference the given Agent in any stage.
func (r *AgentWorkloadReconciler) findWorkloadsForAgent(
	ctx context.Context,
	obj client.Object,
) []reconcile.Request {
	agent, ok := obj.(*konveyoriov1alpha1.Agent)
	if !ok {
		return nil
	}

	var workloadList konveyoriov1alpha1.AgentWorkloadList
	if err := r.List(ctx, &workloadList,
		client.InNamespace(agent.Namespace),
		client.MatchingFields{workloadAgentRefIndexField: agent.Name},
	); err != nil {
		log.FromContext(ctx).Error(err, "Failed to list AgentWorkloads for Agent",
			"agent", agent.Name)
		return nil
	}

	requests := make([]reconcile.Request, len(workloadList.Items))
	for i, pb := range workloadList.Items {
		requests[i] = reconcile.Request{
			NamespacedName: types.NamespacedName{
				Namespace: pb.Namespace,
				Name:      pb.Name,
			},
		}
	}
	return requests
}
