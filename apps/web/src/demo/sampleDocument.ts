import { DocumentPage } from '@jevdeck/contracts';

/**
 * DEMO FIXTURE — synthetic source prose.
 *
 * This is a small redistributable stand-in document used by the demo workspace so the
 * interface is explorable without uploading a real PDF. It is ordinary fixture text in the
 * same shape the PDF parser produces, and generation reads it exactly like a real upload.
 *
 * It is reachable only through `loadDemoWorkspace()`, which is called only when demo mode is
 * explicitly enabled. See `docs/decisions/0001-remediation-requirement-corrections.md`.
 */
const SAMPLE_PAGE_TEXT: string[] = [
  // Pages 1-6 — Chapter 1: resting membrane potential and ionic gradients
  `The resting membrane potential of a typical mammalian neuron is approximately -70 millivolts, a value established chiefly by the permeability of the plasma membrane to potassium ions. Because the membrane contains far more open potassium leak channels than sodium leak channels at rest, the membrane potential settles close to the potassium equilibrium potential. This relationship means that small changes in extracellular potassium concentration produce disproportionately large shifts in neuronal excitability.`,
  `Ion gradients across the neuronal membrane are maintained by the sodium-potassium adenosine triphosphatase, an electrogenic pump that exports three sodium ions for every two potassium ions it imports. The pump consumes roughly twenty percent of the brain's resting energy budget, a cost that reflects the importance of stable gradients for signaling. Because the exchanger is electrogenic, its activity contributes a small negative current to the resting potential.`,
  `The Nernst equation defines the equilibrium potential for a single permeant ion as a function of temperature, valence, and the ratio of external to internal concentration. The Goldman-Hodgkin-Katz equation extends this treatment to several permeant species by weighting each equilibrium potential according to its relative conductance. These equations allow investigators to predict how ion substitution experiments will alter the measured membrane voltage.`,
  `Chloride permeability in mature neurons is low, so the anion contributes little to the resting potential in most central neurons. In some sensory and olfactory neurons, however, chloride conductance is substantial, and opening of chloride channels can depolarize rather than hyperpolarize the cell. This variation means that chloride reversal potentials must be measured rather than assumed for each preparation.`,
  `Astrocytes buffer extracellular potassium through inwardly rectifying potassium channels and by spatial redistribution of the ion across their extensive processes. Because neuronal activity releases potassium into the narrow extracellular space, this buffering capacity is essential for preventing runaway depolarization during sustained firing. Failure of potassium homeostasis has been implicated in cortical spreading depression and in seizure initiation.`,
  `Measurement of the resting potential requires a microelectrode with a tip diameter small enough to avoid membrane damage, together with a reference electrode of stable junction potential. Investigators report a typical resting potential between -60 and -75 millivolts for pyramidal cells, depending on recording temperature and the ionic composition of the bathing solution.`,

  // Pages 7-12 — Action potential dynamics and voltage-gated ion channels
  `The action potential is a transient, all-or-none reversal of the membrane potential that propagates along the axon without decrement. Voltage-gated sodium channels open rapidly upon depolarization and produce a regenerative inward current that drives the membrane toward the sodium equilibrium potential. Because opening of these channels further depolarizes the membrane, the upstroke accelerates until sodium conductance dominates the total membrane conductance.`,
  `The threshold potential is defined as the membrane voltage at which the inward sodium current exactly balances the outward currents carried by potassium and chloride. A depolarization of approximately -55 millivolts typically reaches this threshold in mammalian neurons. Below threshold the depolarization decays passively and no action potential is generated.`,
  `Inactivation of voltage-gated sodium channels is mediated by a cytoplasmic loop that folds into the inner mouth of the pore within a millisecond of opening. Because inactivated channels cannot reopen until the membrane repolarizes, the absolute refractory period sets an upper bound on firing frequency. The refractory period also enforces unidirectional propagation, since channels behind the advancing wave front remain inactivated.`,
  `Voltage-gated potassium channels open with a delay of roughly one millisecond and carry the outward current that repolarizes the membrane. Some of these channels close slowly, producing the afterhyperpolarization that follows a spike and briefly raises the threshold for the next one. Delayed rectifier conductance therefore shapes both the falling phase and the immediate recovery of excitability.`,
  `Myelination increases conduction velocity by restricting the sites of ion exchange to the nodes of Ranvier and by raising the membrane resistance of the internodal segments. Because charge flows almost without loss through the internodal membrane, the action potential is regenerated at successive nodes in a saltatory manner. Demyelinating disease slows or blocks conduction by increasing the capacitance and leak conductance of the internodal membrane.`,
  `Local anesthetics block voltage-gated sodium channels by binding within the pore and stabilizing the inactivated conformation. Because binding is favored when the channel is open, block develops more rapidly in actively firing axons, a property known as use dependence. This selectivity underlies the clinical preference for blocking small, rapidly firing fibers during regional anesthesia.`,

  // Pages 13-18 — Neurotransmitter release and vesicle exocytosis
  `Synaptic vesicles are filled with neurotransmitter by proton-gradient-driven transporters that exchange luminal protons for the transmitter. The vesicular proton gradient is itself generated by an adenosine triphosphatase proton pump in the vesicle membrane. Because filling requires an intact electrochemical gradient, manipulations that collapse the gradient reduce the amount of transmitter available for release.`,
  `Exocytosis begins when calcium enters the presynaptic terminal through voltage-gated calcium channels clustered near the active zone. The calcium sensor is defined as the synaptotagmin family, whose tandem C2 domains bind calcium cooperatively. Because the affinity for calcium is low, high local concentrations near open channels are necessary to trigger fusion.`,
  `The core SNARE complex consists of syntaxin-1, SNAP-25, and synaptobrevin-2 assembled into a parallel four-helix bundle. Formation of this bundle releases free energy that pulls the vesicle membrane toward the plasma membrane and lowers the barrier to fusion. Accessory proteins such as complexin and Munc13 regulate the assembly state and set the number of vesicles poised for release.`,
  `The readily releasable pool is defined as the population of vesicles that can be released within a few milliseconds of calcium entry. Because this pool is small, sustained high-frequency firing depletes it faster than it can be refilled, producing short-term synaptic depression. The reserve pool supplies vesicles during recovery through a process that depends on actin and on synapsin.`,
  `After fusion, vesicle membrane is retrieved by clathrin-mediated endocytosis and returned to the recycling pool. Because endocytosis competes with exocytosis for the same membrane area, the terminal maintains a stable surface area during prolonged activity. Defects in retrieval produce progressive loss of synaptic transmission during sustained stimulation.`,
  `Neurotransmitter release probability varies widely across synapses and is a major determinant of short-term plasticity. Because synapses with high release probability depress readily, they transmit the onset of a burst effectively while attenuating its later components. This arrangement allows a single input to carry both transient and sustained information.`,

  // Pages 19-24 — Chapter 2: long-term potentiation and synaptic plasticity
  `Long-term potentiation at hippocampal Schaffer collateral synapses is defined as a persistent increase in synaptic strength that follows brief, high-frequency stimulation. The change is expressed partly as an increase in the number of postsynaptic AMPA receptors and partly as a change in release probability. Because induction requires coincident presynaptic activity and postsynaptic depolarization, the phenomenon satisfies the requirements of a Hebbian rule.`,
  `The NMDA receptor contributes to induction because its pore is blocked by magnesium at resting potential and unblocks only when the postsynaptic membrane depolarizes. Calcium entering through the unblocked receptor activates calcium-calmodulin-dependent protein kinase II. This enzyme phosphorylates AMPA receptors and promotes their insertion into the postsynaptic membrane.`,
  `Early long-term potentiation lasts minutes to hours and depends on phosphorylation of existing proteins. Late long-term potentiation requires gene expression and protein synthesis, and it is accompanied by enlargement of dendritic spines. Because the late phase is resistant to disruption of the original stimulus, it is considered the cellular correlate of long-term memory storage.`,
  `Long-term depression at the same synapses is induced by low-frequency stimulation and involves modest, sustained calcium elevation. Because the phosphatase calcineurin is preferentially activated by this pattern, AMPA receptors are dephosphorylated and internalized. The balance between potentiation and depression therefore depends on the amplitude and time course of postsynaptic calcium signals.`,
  `Homeostatic plasticity adjusts synaptic strength over hours to keep firing rates within a functional range. Because chronic activity deprivation raises excitability, synaptic scaling can multiply all of a neuron's excitatory weights by a common factor. This global compensation preserves relative differences between inputs while restoring average activity.`,
  `Metaplasticity is defined as a change in the capacity for subsequent plasticity, produced by earlier activity. Because prior stimulation alters the threshold for inducing long-term potentiation, the same stimulus can produce opposite outcomes depending on recent history. This history dependence helps explain why memory formation varies with arousal and behavioral state.`,
];

export const SAMPLE_PAGES: DocumentPage[] = SAMPLE_PAGE_TEXT.map((text, index) => ({
  pageNumber: index + 1,
  text,
}));

export const SAMPLE_PAGE_COUNT = SAMPLE_PAGES.length;

export const SAMPLE_DOCUMENT_NAME = 'DEMO_Principles_of_Neural_Science_Ch1_2.pdf';

/** Word count for a page range, measured from the fixture text itself. */
export function countWordsInRange(pages: DocumentPage[], pageStart: number, pageEnd: number): number {
  return pages
    .filter(p => p.pageNumber >= pageStart && p.pageNumber <= pageEnd)
    .reduce(
      (sum, p) => sum + (p.text.length === 0 ? 0 : p.text.split(/\s+/).filter(w => w.length > 0).length),
      0
    );
}
