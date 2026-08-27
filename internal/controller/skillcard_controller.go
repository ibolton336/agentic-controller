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
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	konveyoriov1alpha1 "github.com/konveyor/agentic-controller/api/v1alpha1"
)

// resolvableRecheckInterval is how often an image-backed SkillCard is
// re-reconciled to refresh its Resolvable condition. A missing artifact may be
// published later, a present one deleted or retagged, and an Unknown result
// clear once the registry is reachable again — so the check self-heals rather
// than freezing whatever the first reconcile saw.
const resolvableRecheckInterval = 10 * time.Minute

// SkillCardReconciler reconciles a SkillCard object.
type SkillCardReconciler struct {
	client.Client
	Scheme *runtime.Scheme

	// Resolver performs the best-effort registry existence check behind the
	// Resolvable condition. When nil, resolvability is not evaluated and image
	// cards carry no Resolvable condition — which keeps envtest and other
	// network-free contexts from reaching out to a registry.
	Resolver ImageResolver
}

// +kubebuilder:rbac:groups=konveyor.io,resources=skillcards,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=konveyor.io,resources=skillcards/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=konveyor.io,resources=skillcards/finalizers,verbs=update

// Reconcile handles SkillCard reconciliation.
//
// For POC, only the image source type is handled: the controller sets
// status.resolvedImage to the spec image and marks the SkillCard Ready.
// Git source and inline content resolution are deferred to Phase 3.
func (r *SkillCardReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var skillCard konveyoriov1alpha1.SkillCard
	if err := r.Get(ctx, req.NamespacedName, &skillCard); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	logger.V(1).Info("Reconciling SkillCard", "name", skillCard.Name)

	// Track the original status for comparison.
	original := skillCard.DeepCopy()

	// Set observed generation.
	skillCard.Status.ObservedGeneration = skillCard.Generation

	// requeueAfter is set for image cards so the Resolvable condition is
	// periodically refreshed; the other delivery modes have nothing to poll.
	var requeueAfter time.Duration

	switch {
	case skillCard.Spec.Image != "":
		requeueAfter = r.reconcileImage(ctx, &skillCard)
	case skillCard.Spec.Source != "":
		r.reconcileSource(&skillCard)
	case skillCard.Spec.Inline != "":
		r.reconcileInline(&skillCard)
	default:
		skillCard.Status.ResolvedImage = ""
		// Otherwise a card that loses its source keeps reporting how it used
		// to be delivered, while Ready correctly flips to False.
		skillCard.Status.DeliveryMode = ""
		// Resolvable only ever describes an image ref; clear any stale one left
		// behind by a card that used to be image-backed.
		meta.RemoveStatusCondition(&skillCard.Status.Conditions, ConditionTypeResolvable)
		meta.SetStatusCondition(&skillCard.Status.Conditions, metav1.Condition{
			Type:               ConditionTypeReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: skillCard.Generation,
			Reason:             "NoSourceConfigured",
			Message:            "No image, source, or inline content is set",
		})
	}

	// Patch status if changed.
	if err := r.Status().Patch(ctx, &skillCard, client.MergeFrom(original)); err != nil {
		logger.Error(err, "Failed to patch SkillCard status")
		return ctrl.Result{}, err
	}

	return ctrl.Result{RequeueAfter: requeueAfter}, nil
}

// reconcileImage handles SkillCards with an OCI image source.
//
// Two guarantees are reported separately, because they are not the same thing:
//
//   - Ready says the spec was accepted — the ref is well-formed and this is how
//     the skill will be delivered. It never waits on a registry, so a transient
//     outage cannot flip a card unready.
//   - Resolvable is a best-effort check that the referenced artifact actually
//     exists. Without it, a well-formed ref to a missing or mistyped artifact
//     reported Ready and only failed much later, at pod runtime, as
//     ImagePullBackOff — the readiness claimed more than it verified (issue
//     #187). Note that even a present manifest does not prove the image holds a
//     usable skill; the frontmatter that decides that is only readable once the
//     volume is mounted, so the skill loader still validates at pod init.
//
// It returns how long until the next refresh of the Resolvable condition.
func (r *SkillCardReconciler) reconcileImage(ctx context.Context, sc *konveyoriov1alpha1.SkillCard) time.Duration {
	sc.Status.ResolvedImage = sc.Spec.Image
	sc.Status.DeliveryMode = "image"
	meta.SetStatusCondition(&sc.Status.Conditions, metav1.Condition{
		Type:               ConditionTypeReady,
		Status:             metav1.ConditionTrue,
		ObservedGeneration: sc.Generation,
		Reason:             "ImageResolved",
		Message:            fmt.Sprintf("OCI image ref accepted: %s", sc.Spec.Image),
	})
	return r.setResolvable(ctx, sc)
}

// setResolvable runs the best-effort registry existence check and records the
// Resolvable condition. It returns the requeue interval for the next refresh,
// or zero when no resolver is configured (resolvability checking disabled).
func (r *SkillCardReconciler) setResolvable(ctx context.Context, sc *konveyoriov1alpha1.SkillCard) time.Duration {
	if r.Resolver == nil {
		// No resolver wired: leave resolvability unevaluated rather than
		// claiming an answer we did not compute.
		meta.RemoveStatusCondition(&sc.Status.Conditions, ConditionTypeResolvable)
		return 0
	}

	result, message := r.Resolver.Resolve(ctx, sc.Spec.Image)
	cond := metav1.Condition{
		Type:               ConditionTypeResolvable,
		ObservedGeneration: sc.Generation,
		Message:            message,
	}
	switch result {
	case imageResolvePresent:
		cond.Status = metav1.ConditionTrue
		cond.Reason = "ArtifactPresent"
	case imageResolveMissing:
		cond.Status = metav1.ConditionFalse
		cond.Reason = "ArtifactMissing"
	default:
		// Inconclusive (auth, network, timeout). Unknown, never False, so a
		// private or momentarily unreachable image the pod could still pull is
		// not wrongly condemned.
		cond.Status = metav1.ConditionUnknown
		cond.Reason = "ResolveInconclusive"
	}
	meta.SetStatusCondition(&sc.Status.Conditions, cond)
	return resolvableRecheckInterval
}

// reconcileSource handles SkillCards with a git source URL.
//
// Nothing is built: the skill loader clones the repository at pod start, so
// there is no image to resolve and status.resolvedImage stays empty. As with
// an image ref, whether the repository actually holds a usable skill is
// settled at pod init.
func (r *SkillCardReconciler) reconcileSource(sc *konveyoriov1alpha1.SkillCard) {
	sc.Status.ResolvedImage = ""
	sc.Status.DeliveryMode = "source"
	// Resolvable is an image-only signal; drop any left from a prior image spec.
	meta.RemoveStatusCondition(&sc.Status.Conditions, ConditionTypeResolvable)
	meta.SetStatusCondition(&sc.Status.Conditions, metav1.Condition{
		Type:               ConditionTypeReady,
		Status:             metav1.ConditionTrue,
		ObservedGeneration: sc.Generation,
		Reason:             "SourceAccepted",
		Message:            fmt.Sprintf("git source accepted, cloned at pod start: %s", sc.Spec.Source),
	})
}

// reconcileInline handles SkillCards with inline markdown content.
//
// This is the one source the controller can genuinely validate: the content is
// already in the CR, so no network is involved. Without frontmatter carrying a
// name and description a skill is invisible to the agent runtime, and an
// unvalidated inline card would otherwise resolve, mount and report Ready
// while contributing nothing.
//
// The delivery mechanism is a ConfigMap the AgentRun controller creates, so
// there is no image and status.resolvedImage stays empty.
func (r *SkillCardReconciler) reconcileInline(sc *konveyoriov1alpha1.SkillCard) {
	sc.Status.ResolvedImage = ""
	sc.Status.DeliveryMode = "inline"
	// Resolvable is an image-only signal; drop any left from a prior image spec.
	meta.RemoveStatusCondition(&sc.Status.Conditions, ConditionTypeResolvable)

	if err := validateInlineSkill(sc.Spec.Inline); err != nil {
		meta.SetStatusCondition(&sc.Status.Conditions, metav1.Condition{
			Type:               ConditionTypeReady,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: sc.Generation,
			Reason:             "InvalidSkillContent",
			Message:            err.Error(),
		})
		return
	}

	meta.SetStatusCondition(&sc.Status.Conditions, metav1.Condition{
		Type:               ConditionTypeReady,
		Status:             metav1.ConditionTrue,
		ObservedGeneration: sc.Generation,
		Reason:             "InlineAccepted",
		Message:            "inline skill content is valid",
	})
}

// SetupWithManager sets up the controller with the Manager.
func (r *SkillCardReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&konveyoriov1alpha1.SkillCard{}).
		Named("skillcard").
		Complete(r)
}
