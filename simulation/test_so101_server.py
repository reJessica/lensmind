from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest import TestCase

from so101_server import DeviceError, Pose, SimulatedArm


class StopTests(TestCase):
    def test_stop_cancels_a_render_in_progress_and_rejects_later_moves(self):
        rendering, release = Event(), Event()

        def render(target):
            if target != Pose():
                rendering.set()
                if not release.wait(timeout=5):
                    raise TimeoutError("Render was never released by the test")
            return {"frame": {"id": str(target)}, "so101": {"shoulderPanDegrees": target.pan_degrees}}

        arm = SimulatedArm(render)
        with ThreadPoolExecutor(max_workers=1) as worker:
            move = worker.submit(arm.move, "PITCH_UP", 1)
            try:
                self.assertTrue(rendering.wait(timeout=5))
                self.assertEqual("MOVING", arm.status()["state"])
                stopped = arm.stop()
                self.assertEqual("STOPPED", stopped["state"])
                self.assertEqual(str(Pose()), stopped["frame"]["id"])
            finally:
                release.set()
            with self.assertRaises(DeviceError) as cancelled:
                move.result(timeout=5)
            self.assertEqual(409, cancelled.exception.code)

        self.assertEqual(stopped, arm.status())
        with self.assertRaises(DeviceError) as rejected:
            arm.move("PITCH_DOWN", 1)
        self.assertEqual(409, rejected.exception.code)
        self.assertEqual("IDLE", arm.home()["state"])

    def test_directions_preserve_other_axes_and_reject_overtravel(self):
        arm = SimulatedArm(lambda pose: {"frame": {"id": str(pose)}})
        arm.move("LEFT", 1)
        arm.move("FORWARD", 2)
        self.assertEqual({"id": str(Pose(-1, 10))}, arm.status()["frame"])
        arm.move("UP", 5)
        arm.move("RIGHT", 2)
        arm.move("BACKWARD", 1)
        self.assertEqual({"id": str(Pose(1, 5, 25))}, arm.status()["frame"])
        limit = arm.move("UP", 1)
        with self.assertRaises(DeviceError) as rejected:
            arm.move("UP", 1)
        self.assertEqual(409, rejected.exception.code)
        self.assertEqual(limit, arm.status())
        arm.move("DOWN", 5)
        self.assertEqual({"id": str(Pose(1, 5, 5))}, arm.status()["frame"])

        arm.move("FORWARD", 5)
        limit = arm.move("FORWARD", 2)
        with self.assertRaises(DeviceError) as rejected:
            arm.move("FORWARD", 1)
        self.assertEqual(409, rejected.exception.code)
        self.assertEqual(limit, arm.status())
        self.assertEqual({"id": str(Pose())}, arm.home()["frame"])

    def test_pitch_keeps_position_and_respects_angular_limit(self):
        arm = SimulatedArm(lambda pose: {"frame": {"id": str(pose)}})
        arm.move("RIGHT", 2)
        arm.move("BACKWARD", 1)
        arm.move("UP", 1)
        arm.move("PITCH_UP", 5)
        limit = arm.move("PITCH_UP", 5)
        self.assertEqual({"id": str(Pose(2, -5, 5, 10))}, limit["frame"])
        with self.assertRaises(DeviceError) as rejected:
            arm.move("PITCH_UP", 1)
        self.assertEqual(409, rejected.exception.code)
        self.assertEqual(limit, arm.status())
        arm.move("PITCH_DOWN", 1)
        self.assertEqual({"id": str(Pose(2, -5, 5, 9))}, arm.status()["frame"])
