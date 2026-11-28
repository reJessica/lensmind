import unittest
import numpy as np
from local_asr_server import Sessions

class Stream:
    def accept_waveform(self, rate, samples):
        self.rate, self.samples = rate, samples

class Recognizer:
    text = '拍摄'
    final = False
    def create_stream(self): return Stream()
    def is_ready(self, stream): return False
    def get_result(self, stream): return self.text
    def is_endpoint(self, stream): return self.final
    def reset(self, stream): self.text = ''

class SessionTests(unittest.TestCase):
    def setUp(self):
        self.recognizer = Recognizer()
        self.sessions = Sessions(self.recognizer)
        self.key = self.sessions.create()
        self.audio = np.zeros(1600, dtype='<f4').tobytes()

    def test_partial_and_final_share_segment_but_final_is_not_lost(self):
        first = self.sessions.process(self.key, 'audio', self.audio)
        self.assertFalse(first[0]['final'])
        self.assertEqual([], self.sessions.process(self.key, 'audio', self.audio))
        self.recognizer.final = True
        final = self.sessions.process(self.key, 'audio', self.audio)
        self.assertTrue(final[0]['final'])
        self.assertEqual(first[0]['segment'], final[0]['segment'])
        self.assertEqual(1, self.sessions.items[self.key]['segment'])

    def test_invalid_audio_and_expired_session_are_rejected(self):
        for audio in [b'', b'abc', b'\0' * 32772, np.array([float('nan')], dtype='<f4').tobytes()]:
            with self.assertRaises(ValueError): self.sessions.process(self.key, 'audio', audio)
        self.sessions.items[self.key]['at'] -= 61
        with self.assertRaises(KeyError): self.sessions.process(self.key, 'audio', self.audio)

    def test_pause_reset_discards_old_stream_and_limits_sessions(self):
        old = self.sessions.items[self.key]['stream']
        self.sessions.process(self.key, 'reset')
        self.assertIsNot(old, self.sessions.items[self.key]['stream'])
        for _ in range(3): self.sessions.create()
        with self.assertRaises(ValueError): self.sessions.create()

if __name__ == '__main__': unittest.main()
