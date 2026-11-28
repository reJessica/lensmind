import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sample_so101_yaw import MAX_YAW_SAMPLE_TICKS, check_yaw
from so101_voice_control import Rejected, YAW, YawControl


class MemoryBus:
    def __init__(self, pose):
        self.pose = pose.copy()
        self.registers = {name: dict.fromkeys(pose, 0) for name in ("Torque_Enable", "Operating_Mode", "Moving")}
        self.writes = []
        self.torque_enables = []

    def sync_read(self, name, **_):
        if name == "Goal_Velocity":
            raise ConnectionError("Sync Read produced no status packet")
        return (self.pose if name == "Present_Position" else self.registers[name]).copy()

    def read(self, name, joint, **_):
        return (self.pose if name == "Present_Position" else self.registers[name])[joint]

    def sync_write(self, name, values, **_):
        self.writes.append((name, values.copy()))
        self.registers[name] = values.copy()

    def write(self, name, joint, value, **_):
        self.writes.append((name, {joint: value}))
        self.registers[name][joint] = value
        self.pose[joint] = value

    def enable_torque(self, joints):
        self.torque_enables.append(tuple(joints))
        for joint in joints:
            self.registers["Torque_Enable"][joint] = 1


class YawControlTests(unittest.TestCase):
    def setUp(self):
        neutral = dict.fromkeys([YAW, "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"], 2048)
        poses = {"neutral": neutral, "left": {**neutral, YAW: 2058}, "right": {**neutral, YAW: 2011}}
        self.bus = MemoryBus(neutral)
        arm = SimpleNamespace(bus=self.bus,
            calibration={joint: SimpleNamespace(range_min=1, range_max=4094) for joint in neutral})
        self.control = YawControl(arm, poses)

    def test_allows_wider_demonstration_with_a_hard_limit(self):
        neutral = self.bus.pose
        taught = {**neutral, YAW: neutral[YAW] + MAX_YAW_SAMPLE_TICKS}
        self.assertEqual(check_yaw(neutral, taught), MAX_YAW_SAMPLE_TICKS)
        with self.assertRaises(ValueError):
            check_yaw(neutral, {**taught, YAW: taught[YAW] + 1})

    @patch("so101_voice_control.sleep")
    @patch("sample_so101_yaw.sleep")
    def test_requires_takeover_bounds_each_action_and_locks_after_stop(self, *_):
        with self.assertRaises(Rejected):
            self.control.move("LEFT", 1)
        self.assertEqual(self.bus.writes, [])
        self.assertEqual(self.control.arm_at_neutral()["state"], "IDLE")
        self.assertEqual(self.control.move("LEFT", 1)["state"], "IDLE")
        self.assertEqual(self.bus.pose[YAW], 2054)
        with self.assertRaises(Rejected):
            self.control.move("LEFT", 1)
        with self.assertRaises(Rejected):
            self.control.move("PITCH_UP", 1)
        self.assertEqual(self.control.stop()["state"], "STOPPED")
        with self.assertRaises(Rejected):
            self.control.move("RIGHT", 1)
        self.assertEqual(self.bus.pose[YAW], 2054)
        writes = len(self.bus.writes)
        self.assertEqual(self.control.stop()["state"], "STOPPED")
        self.assertEqual(self.control.arm_at_neutral()["state"], "IDLE")
        self.assertEqual(len(self.bus.writes), writes)

    @patch("sample_so101_yaw.sleep")
    def test_stop_before_takeover_can_resume_after_confirming_neutral(self, _):
        self.assertEqual(self.control.stop()["state"], "STOPPED")
        self.assertEqual(self.bus.writes, [])
        self.assertEqual(self.control.arm_at_neutral()["state"], "IDLE")

    @patch("sample_so101_yaw.sleep")
    def test_speed_read_failure_blocks_goal_write_and_torque(self, _):
        self.control.stop()
        original_read = self.bus.read

        def fail_speed(name, joint, **kwargs):
            if name == "Goal_Velocity" and joint == YAW:
                raise ConnectionError("no status packet")
            return original_read(name, joint, **kwargs)

        with patch.object(self.bus, "read", side_effect=fail_speed):
            with self.assertRaisesRegex(Rejected, "速度或加速度设置未读回"):
                self.control.arm_at_neutral()
        self.assertEqual([name for name, _ in self.bus.writes], ["Goal_Velocity"])
        self.assertEqual(self.bus.torque_enables, [])
        self.assertEqual(self.control.status()["state"], "STOPPED")

    @patch("sample_so101_yaw.sleep")
    def test_goal_read_failure_blocks_remaining_torque_and_locks_fault(self, _):
        original_read = self.bus.read

        def fail_goal(name, joint, **kwargs):
            if name == "Goal_Position" and joint == YAW:
                raise ConnectionError("no goal readback")
            return original_read(name, joint, **kwargs)

        with patch.object(self.bus, "read", side_effect=fail_goal):
            with self.assertRaises(ConnectionError):
                self.control.arm_at_neutral()
        self.assertEqual(self.bus.torque_enables, [])
        self.assertFalse(self.control.holding)
        self.assertEqual(self.control.status()["state"], "FAULT")

    @patch("sample_so101_yaw.sleep", side_effect=ValueError("unstable"))
    def test_unsteady_pose_can_be_retried_without_clearing_the_lock(self, _):
        self.control.stop()
        with self.assertRaises(Rejected):
            self.control.arm_at_neutral()
        self.assertEqual(self.control.status()["state"], "STOPPED")
        self.assertEqual(self.bus.writes, [])

    @patch("sample_so101_yaw.sleep")
    def test_refuses_takeover_away_from_the_taught_neutral(self, _):
        self.bus.pose[YAW] -= 13
        with self.assertRaisesRegex(Rejected, "向左微转约 1.1°"):
            self.control.arm_at_neutral()
        self.assertEqual(self.bus.writes, [])

    @patch("sample_so101_yaw.sleep")
    def test_accepts_yaw_at_the_new_neutral_threshold(self, _):
        self.bus.pose[YAW] -= 12
        self.assertEqual(self.control.arm_at_neutral()["state"], "IDLE")
        self.assertEqual(self.bus.registers["Goal_Position"][YAW], self.bus.pose[YAW])

    def test_neutral_yaw_hint_uses_the_sampled_direction(self):
        for left_delta, expected in ((10, "右"), (-10, "左")):
            with self.subTest(left_delta=left_delta):
                self.control.directions["LEFT"] = left_delta
                pose = {**self.bus.pose, YAW: self.control.neutral[YAW] + 15}
                with self.assertRaisesRegex(Rejected, f"向{expected}微转约 1.3°"):
                    self.control.check_neutral_yaw(pose)

    @patch("sample_so101_yaw.sleep")
    def test_takeover_holds_the_current_pose_at_the_new_tolerance_boundary(self, _):
        self.bus.pose["elbow_flex"] += 24
        self.assertEqual(self.control.arm_at_neutral()["state"], "IDLE")
        self.assertEqual(self.bus.registers["Goal_Position"], self.bus.pose)

    @patch("sample_so101_yaw.sleep")
    def test_refuses_excessive_posture_offset_with_the_specific_joint(self, _):
        self.bus.pose["wrist_flex"] += 25
        with self.assertRaisesRegex(Rejected, "腕部俯仰偏离中立位 25 刻度"):
            self.control.arm_at_neutral()
        self.assertEqual(self.bus.writes, [])

    def test_neutral_tolerance_does_not_override_calibrated_joint_limits(self):
        self.bus.pose["elbow_flex"] += 20
        self.control.arm.calibration["elbow_flex"].range_max = 2050
        with self.assertRaisesRegex(Rejected, "超出舵机校准范围"):
            self.control.check_workspace(self.bus.pose)

    def test_status_falls_back_to_individual_reads_when_group_feedback_fails(self):
        self.control.state = "IDLE"
        self.bus.registers["Torque_Enable"] = dict.fromkeys(self.bus.pose, 1)
        with patch.object(self.bus, "sync_read", side_effect=ConnectionError("no status packet")) as group_read:
            self.assertEqual(self.control.live_status()["state"], "IDLE")
            self.assertEqual(self.control.live_status()["state"], "IDLE")
        self.assertEqual(group_read.call_count, 3)
        self.assertEqual(self.bus.writes, [])

    def test_status_keeps_the_failing_feedback_register_in_fault_details(self):
        self.control.state = "IDLE"
        with patch.object(self.bus, "sync_read", side_effect=ConnectionError("no group response")), \
                patch.object(self.bus, "read", side_effect=ConnectionError("no motor response")):
            result = self.control.live_status()
        self.assertEqual(result["state"], "FAULT")
        self.assertIn("Present_Position", result["message"])
        self.assertEqual(self.bus.writes, [])

    @patch("sample_so101_yaw.sleep")
    def test_stop_keeps_torque_until_an_explicit_supported_release(self, _):
        self.control.arm_at_neutral()
        with self.assertRaisesRegex(Rejected, "先停止操控"):
            self.control.release_torque(True)
        stopped = self.control.stop()
        self.assertTrue(stopped["torqueHeld"])
        writes = len(self.bus.writes)
        with self.assertRaisesRegex(Rejected, "先确认"):
            self.control.release_torque(False)
        self.assertEqual(len(self.bus.writes), writes)
        self.assertFalse(self.control.release_torque(True)["torqueHeld"])
        self.assertEqual(self.control.status()["state"], "STOPPED")
        self.assertEqual([name for name, _ in self.bus.writes[writes:]], ["Torque_Enable"])
        self.assertFalse(self.control.release_torque(True)["torqueHeld"])
        self.assertEqual(len(self.bus.writes), writes + 1)

    def test_release_rejects_motion_without_writing(self):
        self.control.state = "STOPPED"
        self.control.holding = True
        self.bus.registers["Moving"][YAW] = 1
        with self.assertRaisesRegex(Rejected, "尚未停稳"):
            self.control.release_torque(True)
        self.assertEqual(self.bus.writes, [])

    def test_restored_hold_can_be_released_but_cannot_rearm_directly(self):
        self.control.state = "STOPPED"
        self.control.holding = True
        self.control.restored_hold = True
        self.bus.registers["Torque_Enable"] = dict.fromkeys(self.bus.pose, 1)
        with self.assertRaisesRegex(Rejected, "先托稳并卸力"):
            self.control.arm_at_neutral()
        self.assertEqual(self.bus.writes, [])
        self.assertFalse(self.control.release_torque(True)["torqueHeld"])
        self.assertFalse(self.control.restored_hold)

    def test_failed_torque_readback_cannot_trigger_a_holding_write(self):
        self.control.state = "STOPPED"
        self.control.holding = True
        self.bus.registers["Torque_Enable"] = dict.fromkeys(self.bus.pose, 1)
        with patch.object(self.bus, "sync_write") as write:
            with self.assertRaisesRegex(RuntimeError, "未确认六轴全部卸力"):
                self.control.release_torque(True)
        self.assertFalse(self.control.holding)
        self.assertEqual(write.call_args.args[0], "Torque_Enable")


if __name__ == "__main__":
    unittest.main()
