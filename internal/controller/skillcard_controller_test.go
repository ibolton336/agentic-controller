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
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	konveyoriov1alpha1 "github.com/konveyor/agentic-controller/api/v1alpha1"
)

// fakeImageResolver stands in for a real registry so the Resolvable condition
// can be driven deterministically in envtest. The outcome is keyed by a marker
// in the ref; anything unrecognized is Unknown, which leaves the existing
// image-source tests (that only assert Ready) unaffected while a real registry
// is never contacted.
type fakeImageResolver struct{}

func (fakeImageResolver) Resolve(_ context.Context, ref string) (imageResolution, string) {
	switch {
	case strings.Contains(ref, "resolvable-present"):
		return imageResolvePresent, "manifest found in registry: " + ref
	case strings.Contains(ref, "resolvable-missing"):
		return imageResolveMissing, "no manifest for " + ref + " in its registry"
	default:
		return imageResolveUnknown, "existence not confirmed for " + ref
	}
}

var _ = Describe("SkillCard Controller", func() {
	const (
		timeout  = 10 * time.Second
		interval = 250 * time.Millisecond
	)

	Context("when reconciling a SkillCard with an image source", func() {
		const (
			name  = "sc-ctrl-image"
			image = "quay.io/konveyor/skills/maven-migration:1.0.0"
		)

		It("should set resolvedImage and Ready=True", func() {
			sc := &konveyoriov1alpha1.SkillCard{
				ObjectMeta: metav1.ObjectMeta{
					Name:      name,
					Namespace: testNamespace,
				},
				Spec: konveyoriov1alpha1.SkillCardSpec{
					Image: image,
				},
			}
			Expect(k8sClient.Create(ctx, sc)).To(Succeed())

			key := types.NamespacedName{Name: name, Namespace: testNamespace}
			Eventually(func(g Gomega) {
				var fetched konveyoriov1alpha1.SkillCard
				g.Expect(k8sClient.Get(ctx, key, &fetched)).To(Succeed())
				g.Expect(fetched.Status.ResolvedImage).To(Equal(image))

				readyCond := meta.FindStatusCondition(fetched.Status.Conditions, ConditionTypeReady)
				g.Expect(readyCond).NotTo(BeNil())
				g.Expect(readyCond.Status).To(Equal(metav1.ConditionTrue))
				g.Expect(readyCond.Reason).To(Equal("ImageResolved"))
				g.Expect(fetched.Status.ObservedGeneration).To(Equal(fetched.Generation))
			}, timeout, interval).Should(Succeed())

			Expect(k8sClient.Delete(ctx, sc)).To(Succeed())
		})
	})

	Context("when reconciling a SkillCard with a source URL", func() {
		const name = "sc-ctrl-source"

		// Nothing is built: the loader clones the repository at pod start, so
		// there is no image to resolve.
		It("should be Ready with no resolved image", func() {
			sc := &konveyoriov1alpha1.SkillCard{
				ObjectMeta: metav1.ObjectMeta{
					Name:      name,
					Namespace: testNamespace,
				},
				Spec: konveyoriov1alpha1.SkillCardSpec{
					Source: "https://github.com/konveyor/skills/tree/main/maven",
				},
			}
			Expect(k8sClient.Create(ctx, sc)).To(Succeed())

			key := types.NamespacedName{Name: name, Namespace: testNamespace}
			Eventually(func(g Gomega) {
				var fetched konveyoriov1alpha1.SkillCard
				g.Expect(k8sClient.Get(ctx, key, &fetched)).To(Succeed())
				g.Expect(fetched.Status.ResolvedImage).To(BeEmpty())

				readyCond := meta.FindStatusCondition(fetched.Status.Conditions, ConditionTypeReady)
				g.Expect(readyCond).NotTo(BeNil())
				g.Expect(readyCond.Status).To(Equal(metav1.ConditionTrue))
				g.Expect(readyCond.Reason).To(Equal("SourceAccepted"))
			}, timeout, interval).Should(Succeed())

			Expect(k8sClient.Delete(ctx, sc)).To(Succeed())
		})
	})

	Context("when reconciling a SkillCard with inline content", func() {
		// Inline is the one source the controller can validate without
		// network, because the content is already in the CR.
		It("should be Ready when the content carries valid frontmatter", func() {
			const name = "sc-ctrl-inline"
			sc := &konveyoriov1alpha1.SkillCard{
				ObjectMeta: metav1.ObjectMeta{
					Name:      name,
					Namespace: testNamespace,
				},
				Spec: konveyoriov1alpha1.SkillCardSpec{
					Inline: "---\nname: no-javax\ndescription: never leave javax imports\n---\n\nDo not use javax packages.\n",
					Type:   konveyoriov1alpha1.SkillCardTypeRule,
				},
			}
			Expect(k8sClient.Create(ctx, sc)).To(Succeed())

			key := types.NamespacedName{Name: name, Namespace: testNamespace}
			Eventually(func(g Gomega) {
				var fetched konveyoriov1alpha1.SkillCard
				g.Expect(k8sClient.Get(ctx, key, &fetched)).To(Succeed())
				// Delivered as a ConfigMap, so there is no image.
				g.Expect(fetched.Status.ResolvedImage).To(BeEmpty())

				readyCond := meta.FindStatusCondition(fetched.Status.Conditions, ConditionTypeReady)
				g.Expect(readyCond).NotTo(BeNil())
				g.Expect(readyCond.Status).To(Equal(metav1.ConditionTrue))
				g.Expect(readyCond.Reason).To(Equal("InlineAccepted"))
			}, timeout, interval).Should(Succeed())

			Expect(k8sClient.Delete(ctx, sc)).To(Succeed())
		})

		// Without frontmatter the skill is invisible to the agent runtime. It
		// must not report Ready while contributing nothing.
		It("should set Ready=False when the content has no frontmatter", func() {
			const name = "sc-ctrl-inline-invalid"
			sc := &konveyoriov1alpha1.SkillCard{
				ObjectMeta: metav1.ObjectMeta{
					Name:      name,
					Namespace: testNamespace,
				},
				Spec: konveyoriov1alpha1.SkillCardSpec{
					Inline: "# No javax\nDo not use javax packages.",
				},
			}
			Expect(k8sClient.Create(ctx, sc)).To(Succeed())

			key := types.NamespacedName{Name: name, Namespace: testNamespace}
			Eventually(func(g Gomega) {
				var fetched konveyoriov1alpha1.SkillCard
				g.Expect(k8sClient.Get(ctx, key, &fetched)).To(Succeed())

				readyCond := meta.FindStatusCondition(fetched.Status.Conditions, ConditionTypeReady)
				g.Expect(readyCond).NotTo(BeNil())
				g.Expect(readyCond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(readyCond.Reason).To(Equal("InvalidSkillContent"))
				g.Expect(readyCond.Message).To(ContainSubstring("frontmatter"))
			}, timeout, interval).Should(Succeed())

			Expect(k8sClient.Delete(ctx, sc)).To(Succeed())
		})
	})

	Context("when a SkillCard image is updated", func() {
		const (
			name    = "sc-ctrl-image-update"
			imageV1 = "quay.io/konveyor/skills:maven-v1"
			imageV2 = "quay.io/konveyor/skills:maven-v2"
		)

		It("should update resolvedImage to the new image", func() {
			sc := &konveyoriov1alpha1.SkillCard{
				ObjectMeta: metav1.ObjectMeta{
					Name:      name,
					Namespace: testNamespace,
				},
				Spec: konveyoriov1alpha1.SkillCardSpec{
					Image: imageV1,
				},
			}
			Expect(k8sClient.Create(ctx, sc)).To(Succeed())

			key := types.NamespacedName{Name: name, Namespace: testNamespace}
			Eventually(func(g Gomega) {
				var fetched konveyoriov1alpha1.SkillCard
				g.Expect(k8sClient.Get(ctx, key, &fetched)).To(Succeed())
				g.Expect(fetched.Status.ResolvedImage).To(Equal(imageV1))
			}, timeout, interval).Should(Succeed())

			By("updating the image to v2")
			var current konveyoriov1alpha1.SkillCard
			Expect(k8sClient.Get(ctx, key, &current)).To(Succeed())
			current.Spec.Image = imageV2
			Expect(k8sClient.Update(ctx, &current)).To(Succeed())

			Eventually(func(g Gomega) {
				var fetched konveyoriov1alpha1.SkillCard
				g.Expect(k8sClient.Get(ctx, key, &fetched)).To(Succeed())
				g.Expect(fetched.Status.ResolvedImage).To(Equal(imageV2))
			}, timeout, interval).Should(Succeed())

			Expect(k8sClient.Delete(ctx, sc)).To(Succeed())
		})
	})

	// The Resolvable condition is the best-effort registry existence check that
	// separates "spec accepted" (Ready) from "the artifact actually exists"
	// (issue #187). A missing artifact must stay Ready but flip Resolvable=False
	// so a phantom card is visible before a run ImagePullBackOffs.
	Context("when reconciling an image SkillCard's resolvability", func() {
		newCard := func(name, image string) *konveyoriov1alpha1.SkillCard {
			return &konveyoriov1alpha1.SkillCard{
				ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
				Spec:       konveyoriov1alpha1.SkillCardSpec{Image: image},
			}
		}

		It("should set Resolvable=True when the artifact exists, alongside Ready=True", func() {
			const name = "sc-resolvable-present"
			sc := newCard(name, "quay.io/konveyor/skills:resolvable-present")
			Expect(k8sClient.Create(ctx, sc)).To(Succeed())

			key := types.NamespacedName{Name: name, Namespace: testNamespace}
			Eventually(func(g Gomega) {
				var fetched konveyoriov1alpha1.SkillCard
				g.Expect(k8sClient.Get(ctx, key, &fetched)).To(Succeed())

				ready := meta.FindStatusCondition(fetched.Status.Conditions, ConditionTypeReady)
				g.Expect(ready).NotTo(BeNil())
				g.Expect(ready.Status).To(Equal(metav1.ConditionTrue))

				resolvable := meta.FindStatusCondition(fetched.Status.Conditions, ConditionTypeResolvable)
				g.Expect(resolvable).NotTo(BeNil())
				g.Expect(resolvable.Status).To(Equal(metav1.ConditionTrue))
				g.Expect(resolvable.Reason).To(Equal("ArtifactPresent"))
			}, timeout, interval).Should(Succeed())

			Expect(k8sClient.Delete(ctx, sc)).To(Succeed())
		})

		// The phantom-card case: a well-formed ref to a tag that was never
		// published. Ready stays True (the spec is accepted), Resolvable=False
		// surfaces the problem before run time.
		It("should stay Ready but set Resolvable=False when the artifact is missing", func() {
			const name = "sc-resolvable-missing"
			sc := newCard(name, "quay.io/konveyor/skills:resolvable-missing")
			Expect(k8sClient.Create(ctx, sc)).To(Succeed())

			key := types.NamespacedName{Name: name, Namespace: testNamespace}
			Eventually(func(g Gomega) {
				var fetched konveyoriov1alpha1.SkillCard
				g.Expect(k8sClient.Get(ctx, key, &fetched)).To(Succeed())

				ready := meta.FindStatusCondition(fetched.Status.Conditions, ConditionTypeReady)
				g.Expect(ready).NotTo(BeNil())
				g.Expect(ready.Status).To(Equal(metav1.ConditionTrue))

				resolvable := meta.FindStatusCondition(fetched.Status.Conditions, ConditionTypeResolvable)
				g.Expect(resolvable).NotTo(BeNil())
				g.Expect(resolvable.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(resolvable.Reason).To(Equal("ArtifactMissing"))
			}, timeout, interval).Should(Succeed())

			Expect(k8sClient.Delete(ctx, sc)).To(Succeed())
		})

		// An image the controller cannot confirm (e.g. private, no creds) must
		// not be condemned: Resolvable=Unknown, never False.
		It("should set Resolvable=Unknown when the check is inconclusive", func() {
			const name = "sc-resolvable-unknown"
			sc := newCard(name, "quay.io/konveyor/private:latest")
			Expect(k8sClient.Create(ctx, sc)).To(Succeed())

			key := types.NamespacedName{Name: name, Namespace: testNamespace}
			Eventually(func(g Gomega) {
				var fetched konveyoriov1alpha1.SkillCard
				g.Expect(k8sClient.Get(ctx, key, &fetched)).To(Succeed())

				resolvable := meta.FindStatusCondition(fetched.Status.Conditions, ConditionTypeResolvable)
				g.Expect(resolvable).NotTo(BeNil())
				g.Expect(resolvable.Status).To(Equal(metav1.ConditionUnknown))
				g.Expect(resolvable.Reason).To(Equal("ResolveInconclusive"))
			}, timeout, interval).Should(Succeed())

			Expect(k8sClient.Delete(ctx, sc)).To(Succeed())
		})

		// Resolvable is an image-only signal. A card that switches away from an
		// image source must not keep reporting a stale Resolvable condition.
		It("should drop Resolvable when the card switches to inline", func() {
			const name = "sc-resolvable-cleared"
			sc := newCard(name, "quay.io/konveyor/skills:resolvable-missing")
			Expect(k8sClient.Create(ctx, sc)).To(Succeed())

			key := types.NamespacedName{Name: name, Namespace: testNamespace}
			Eventually(func(g Gomega) {
				var fetched konveyoriov1alpha1.SkillCard
				g.Expect(k8sClient.Get(ctx, key, &fetched)).To(Succeed())
				g.Expect(meta.FindStatusCondition(fetched.Status.Conditions, ConditionTypeResolvable)).NotTo(BeNil())
			}, timeout, interval).Should(Succeed())

			By("switching the source from image to inline")
			var current konveyoriov1alpha1.SkillCard
			Expect(k8sClient.Get(ctx, key, &current)).To(Succeed())
			current.Spec.Image = ""
			current.Spec.Inline = "---\nname: switched\ndescription: now inline\n---\n\nbody\n"
			Expect(k8sClient.Update(ctx, &current)).To(Succeed())

			Eventually(func(g Gomega) {
				var fetched konveyoriov1alpha1.SkillCard
				g.Expect(k8sClient.Get(ctx, key, &fetched)).To(Succeed())
				g.Expect(fetched.Status.DeliveryMode).To(Equal("inline"))
				g.Expect(meta.FindStatusCondition(fetched.Status.Conditions, ConditionTypeResolvable)).To(BeNil())
			}, timeout, interval).Should(Succeed())

			Expect(k8sClient.Delete(ctx, sc)).To(Succeed())
		})
	})
})
