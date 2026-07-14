import contextlib
import io
import importlib.util
from pathlib import Path
import sys
import unittest


SCRIPT_PATH = Path(__file__).with_name('train_ptbr_wake.py')


def load_training_module():
    spec = importlib.util.spec_from_file_location('train_ptbr_wake', SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError('não foi possível carregar o script de treino')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class PtBrWakeTrainingScriptTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.training = load_training_module()

    def test_generation_specs_are_reproducible_and_include_ptbr_variants(self):
        voices = ['pt-BR-AntonioNeural', 'pt-BR-FranciscaNeural']
        first = self.training.build_tts_specs(voices, 12, 42)
        second = self.training.build_tts_specs(voices, 12, 42)

        self.assertEqual(first, second)
        self.assertEqual(len(first), 12)
        self.assertTrue(all(item.text in self.training.TARGET_PHRASES for item in first))
        self.assertTrue({'Hey Jarvis', 'Ei Jarvis', 'E aí Jarvis'} <= set(self.training.TARGET_PHRASES))

    def test_candidate_destination_rejects_the_live_nexus_model(self):
        live_model = Path.home() / '.nexus/models/wake/custom.onnx'

        with self.assertRaises(ValueError):
            self.training.resolve_candidate_output(live_model)

    def test_candidate_sidecars_stay_next_to_the_candidate(self):
        candidate = Path('/tmp/hey_jarvis_ptbr_candidate.onnx')
        report, manifest = self.training.candidate_sidecars(candidate)

        self.assertEqual(report, candidate.with_suffix('.metrics.json'))
        self.assertEqual(manifest, candidate.with_suffix('.manifest.json'))

    def test_default_source_count_adapts_to_available_ptbr_voices(self):
        voices = ['pt-BR-AntonioNeural', 'pt-BR-FranciscaNeural']
        available = len(voices) * len(self.training.TARGET_PHRASES) * len(self.training.RATES) * len(
            self.training.PITCHES,
        )

        self.assertEqual(self.training.resolve_source_clip_count(voices, None), available)
        self.assertEqual(self.training.resolve_source_clip_count(voices, 400), 400)
        with self.assertRaises(ValueError):
            self.training.resolve_source_clip_count(voices, available + 1)

    def test_workspace_inside_nexus_is_rejected_before_any_write(self):
        forbidden = Path.home() / '.nexus/training/wake-ptbr-test'

        with self.assertRaises(ValueError):
            self.training.prepare_workspace(forbidden)

    def test_batch_size_requires_a_positive_and_negative_example(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                self.training.parse_args(['--batch-size', '3'])

    def test_metrics_include_the_runtime_custom_threshold(self):
        class FakeArray(list):
            def __lt__(self, threshold):
                return FakeArray(value < threshold for value in self)

            def __ge__(self, threshold):
                return FakeArray(value >= threshold for value in self)

        class FakeNumpy:
            @staticmethod
            def mean(values):
                return sum(values) / len(values)

        report = self.training.threshold_report(FakeNumpy, FakeArray([0.7]), FakeArray([0.6]))

        self.assertIn(
            self.training.RUNTIME_CUSTOM_THRESHOLD,
            [entry['threshold'] for entry in report],
        )


if __name__ == '__main__':
    unittest.main()
