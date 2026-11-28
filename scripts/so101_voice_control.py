"""Local, operator-enabled SO-101 yaw control for LensMind."""

import argparse
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from threading import Lock
from time import monotonic, sleep

from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
from sample_so101_yaw import YAW, check_yaw, read_pose


class Rejected(ValueError):
    pass


class YawControl:
    STEP = 6
    VELOCITY = 35
    ACCELERATION = 5
    TOLERANCE = 3
    NEUTRAL_POSTURE_TOLERANCE = 24
    NEUTRAL_YAW_TOLERANCE = 12
    POSTURE_LABELS = {
        "shoulder_lift": "肩部俯仰", "elbow_flex": "肘部", "wrist_flex": "腕部俯仰",
        "wrist_roll": "腕部旋转", "gripper": "夹爪",
    }

    def __init__(self, arm, poses):
        self.arm = arm
        self.bus = arm.bus
        self.neutral = poses["neutral"]
        for pose in (self.neutral, poses["left"], poses["right"]):
            if pose.keys() != arm.calibration.keys() or any(
                type(value) is not int or not arm.calibration[joint].range_min <= value <= arm.calibration[joint].range_max
                for joint, value in pose.items()
            ):
                raise ValueError("采样数据不在六轴校准范围内")
        self.directions = {key: check_yaw(self.neutral, poses[key.lower()]) for key in ("LEFT", "RIGHT")}
        if self.directions["LEFT"] * self.directions["RIGHT"] >= 0:
            raise ValueError("左右示范必须在中立位两侧")
        self.low, self.high = sorted(poses[key][YAW] for key in ("left", "right"))
        self.lock = Lock()
        self.state = "UNARMED"
        self.holding = False
        self.restored_hold = False
        self.fault_reason = ""
        self.individual_feedback = set()

    def status(self):
        return {"mode": "SO101", "connected": self.state != "FAULT", "state": self.state,
                "torqueHeld": self.holding if self.state != "FAULT" else None,
                "x": 0, "y": 0, "message": {"UNARMED": "等待启用实机语音控制", "IDLE": "机械臂已停稳",
                    "MOVING": "机械臂正在微调", "STOPPED": "已停止，语音移动已锁定",
                    "FAULT": self.fault_reason or "实机状态异常，请现场确认"}.get(self.state, "")}

    def live_status(self):
        with self.lock:
            if self.state == "IDLE":
                try:
                    self.check_workspace(self.read_feedback("Present_Position"))
                    if any(self.read_feedback("Moving").values()):
                        return {**self.status(), "state": "MOVING", "message": "机械臂尚未停稳"}
                    if not all(self.read_feedback("Torque_Enable").values()):
                        raise Rejected("至少一轴舵机失去保持力")
                except Exception as error:
                    self.record_fault(error)
            return self.status()

    def record_fault(self, error):
        self.fault_reason = str(error)
        self.state = "FAULT"
        print(f"实机故障：{error}", flush=True)

    def check_calibrated_pose(self, pose):
        if pose.keys() != self.arm.calibration.keys() or any(
            not self.arm.calibration[joint].range_min <= value <= self.arm.calibration[joint].range_max
            for joint, value in pose.items()
        ):
            raise Rejected("机械臂超出舵机校准范围或未读到六轴位置")

    def check_workspace(self, pose):
        self.check_calibrated_pose(pose)
        if not self.low <= pose[YAW] <= self.high:
            raise Rejected("底座转向已超出本次采样的左右范围")
        difference, joint = max((abs(pose[joint] - self.neutral[joint]), joint) for joint in self.POSTURE_LABELS)
        if difference > self.NEUTRAL_POSTURE_TOLERANCE:
            raise Rejected(
                f"{self.POSTURE_LABELS[joint]}偏离中立位 {difference} 刻度"
                f"（允许 {self.NEUTRAL_POSTURE_TOLERANCE} 刻度），请托稳后调整该关节"
            )

    def arm_at_neutral(self):
        with self.lock:
            if self.state not in ("UNARMED", "STOPPED"):
                raise Rejected("实机已接管或已锁定")
            if self.restored_hold:
                raise Rejected("当前为重连后保留的保持状态，请先托稳并卸力再重新启用")
            try:
                return self.resume_at_rest()
            except ValueError as error:
                raise Rejected(str(error)) from error

    def check_neutral_yaw(self, pose):
        offset = pose[YAW] - self.neutral[YAW]
        if abs(offset) > self.NEUTRAL_YAW_TOLERANCE:
            correction = "右" if offset * self.directions["LEFT"] > 0 else "左"
            degrees = abs(offset) * 360 / 4096
            raise Rejected(f"底座朝向偏离中立位，请托稳后手动向{correction}微转约 {degrees:.1f}°")

    def resume_at_rest(self):
        pose = read_pose(self.arm)
        self.check_workspace(pose)
        torque = self.read_feedback("Torque_Enable")
        if self.holding:
            goals = self.read_feedback("Goal_Position")
            if not all(torque.values()) or any(self.read_feedback("Moving").values()) or any(
                abs(pose[joint] - goals[joint]) > self.TOLERANCE for joint in pose
            ):
                raise Rejected("机械臂未确认保持当前位置，语音移动仍锁定")
            self.state = "IDLE"
            return self.status()
        self.check_neutral_yaw(pose)
        if any(torque.values()):
            raise Rejected("舵机已有保持力，请检查是否由其他程序接管")
        if any(self.read_feedback("Operating_Mode").values()):
            raise Rejected("舵机未处于位置模式，请核对校准")
        self.configure_motion()
        fresh_pose = read_pose(self.arm)
        self.check_workspace(fresh_pose)
        self.check_neutral_yaw(fresh_pose)
        if any(abs(value - pose[joint]) > 2 for joint, value in fresh_pose.items()):
            raise Rejected("姿态已变化，请托稳后重试")
        if any(self.read_each("Torque_Enable").values()):
            raise Rejected("舵机保持力已变化，接管仍锁定")
        try:
            # On some firmware a goal write can itself engage holding force.
            self.bus.sync_write("Goal_Position", fresh_pose, normalize=False)
            if self.read_each("Goal_Position") != fresh_pose:
                raise RuntimeError("位置目标读回不匹配")
            if any(abs(value - fresh_pose[joint]) > 2 for joint, value in read_pose(self.arm).items()):
                raise RuntimeError("写入位置目标后姿态发生变化")
            released = [joint for joint, value in self.read_each("Torque_Enable").items() if not value]
            if released:
                self.bus.enable_torque(released)
            if not all(self.read_each("Torque_Enable").values()):
                raise RuntimeError("舵机未全部确认接管")
        except Exception as error:
            self.record_fault(error)
            raise
        self.holding = True
        self.state = "IDLE"
        return self.status()

    def read_each(self, register):
        return {joint: self.bus.read(register, joint, normalize=False, num_retry=2) for joint in self.neutral}

    def read_feedback(self, register):
        if register not in self.individual_feedback:
            try:
                values = self.bus.sync_read(register, normalize=False, num_retry=1)
                if values.keys() == self.neutral.keys():
                    return values
            except ConnectionError:
                pass
        try:
            values = self.read_each(register)
        except (ConnectionError, RuntimeError) as error:
            raise RuntimeError(f"{register} 读回失败：{error}") from error
        if register not in self.individual_feedback:
            self.individual_feedback.add(register)
            print(f"{register} 批量反馈不可用，本次连接改为逐轴读取。", flush=True)
        return values

    def configure_motion(self):
        try:
            for register, value in (("Goal_Velocity", self.VELOCITY), ("Acceleration", self.ACCELERATION)):
                expected = dict.fromkeys(self.neutral, value)
                self.bus.sync_write(register, expected, normalize=False)
                if self.read_each(register) != expected:
                    raise Rejected(f"{register} 读回值不一致，接管仍锁定")
                print(f"接管参数已核验：{register}={value}（六轴写入并逐轴读回）", flush=True)
        except (ConnectionError, RuntimeError) as error:
            print(f"接管参数读回失败：{error}", flush=True)
            raise Rejected("速度或加速度设置未读回，机械臂仍锁定") from error

    def stop(self):
        with self.lock:
            if self.state == "STOPPED":
                return self.status()
            self.state = "STOPPING"
            if self.holding:
                present = self.read_feedback("Present_Position")
                try:
                    self.check_calibrated_pose(present)
                except Rejected as error:
                    raise RuntimeError("当前位置无法安全用作停止目标，请现场确认机械臂") from error
                self.bus.sync_write("Goal_Position", present, normalize=False)
                if self.read_feedback("Goal_Position") != present:
                    raise RuntimeError("停止目标读回失败")
                deadline = monotonic() + 0.8
                while any(self.read_feedback("Moving").values()):
                    if monotonic() >= deadline:
                        raise RuntimeError("舵机未确认停稳")
                    sleep(0.04)
            self.state = "STOPPED"
            return self.status()

    def release_torque(self, supported):
        with self.lock:
            if supported is not True:
                raise Rejected("请先确认你已托稳机械臂")
            if self.state != "STOPPED":
                raise Rejected("先停止操控，等控制端确认停稳后再卸力")
            if any(self.read_feedback("Moving").values()):
                raise Rejected("机械臂尚未停稳，不能卸力")
            torque = self.read_each("Torque_Enable")
            self.holding = False
            if any(torque.values()):
                self.bus.sync_write("Torque_Enable", dict.fromkeys(torque, 0), normalize=False)
                if any(self.read_each("Torque_Enable").values()):
                    raise RuntimeError("未确认六轴全部卸力，请继续托稳机械臂")
            self.restored_hold = False
            return self.status()

    def move(self, direction, step):
        with self.lock:
            if direction not in self.directions or type(step) is not int or step != 1:
                raise Rejected("实机只接受一次向左或向右微转")
            if self.state != "IDLE":
                raise Rejected("实机未就绪或正在执行动作")
            pose = self.read_feedback("Present_Position")
            self.check_workspace(pose)
            if not all(self.read_feedback("Torque_Enable").values()):
                raise RuntimeError("舵机未保持当前姿态")
            sign = 1 if self.directions[direction] > 0 else -1
            target = pose[YAW] + sign * self.STEP
            if not self.low <= target <= self.high:
                raise Rejected("已到本次示范的转向边界")
            self.bus.write("Goal_Position", YAW, target, normalize=False)
            self.state = "MOVING"
        deadline = monotonic() + 0.9
        while monotonic() < deadline:
            sleep(0.05)
            with self.lock:
                if self.state != "MOVING":
                    raise Rejected("本次微调已停止")
                pose = self.read_feedback("Present_Position")
                moving = self.read_feedback("Moving")
                self.check_workspace(pose)
                if not any(moving.values()) and abs(pose[YAW] - target) <= self.TOLERANCE:
                    self.state = "IDLE"
                    return self.status()
        self.stop()
        raise Rejected("微调超时，已尝试停止并锁定")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--calibration", required=True, type=Path)
    parser.add_argument("--poses", required=True, type=Path)
    service_mode = parser.add_mutually_exclusive_group(required=True)
    service_mode.add_argument("--listen", type=int)
    service_mode.add_argument("--probe-only", action="store_true")
    parser.add_argument("--start-stopped", action="store_true")
    parser.add_argument("--resume-stopped-hold", action="store_true",
        help="Read-only handoff of a stopped, torque-held arm from the previous local bridge")
    args = parser.parse_args()
    if args.resume_stopped_hold and (not args.start_stopped or args.probe_only):
        parser.error("--resume-stopped-hold requires --listen and --start-stopped")
    token = "" if args.probe_only else os.environ["LENSMIND_SO101_TOKEN"]
    calibration = args.calibration.resolve()
    poses = json.loads(args.poses.read_text(encoding="utf-8"))
    if hashlib.sha256(calibration.read_bytes()).hexdigest() != poses.get("calibration_sha256"):
        raise ValueError("左右示范关联的校准文件已变化")
    arm = SO101Follower(SO101FollowerConfig(port=args.port, id=calibration.stem,
        calibration_dir=calibration.parent, disable_torque_on_disconnect=False))
    control = YawControl(arm, poses)
    if args.start_stopped:
        control.state = "STOPPED"

    class Handler(BaseHTTPRequestHandler):
        def respond(self, code, body):
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def dispatch(self, post=False):
            if not hmac.compare_digest(self.headers.get("X-LensMind-Token", ""), token):
                return self.respond(403, {"message": "控制服务认证失败"})
            if not post and self.path == "/status":
                return self.respond(200, control.live_status())
            if not post or self.path not in ("/arm", "/move", "/stop", "/release"):
                return self.respond(404, {"message": "未知控制操作"})
            try:
                if self.path in ("/move", "/release"):
                    size = int(self.headers.get("Content-Length", "0"))
                    if not 0 < size <= 512:
                        raise Rejected("移动请求格式无效")
                    body = json.loads(self.rfile.read(size))
                    if not isinstance(body, dict):
                        raise Rejected("移动请求格式无效")
                    result = (control.release_torque(body.get("supported")) if self.path == "/release"
                        else control.move(body.get("direction"), body.get("step")))
                else:
                    result = (control.arm_at_neutral if self.path == "/arm" else control.stop)()
            except Rejected as error:
                if control.state == "MOVING":
                    try:
                        control.stop()
                    except Exception as stop_error:
                        control.record_fault(stop_error)
                return self.respond(409, {"message": str(error)})
            except Exception as error:
                try:
                    if control.holding and self.path != "/release":
                        control.stop()
                except Exception:
                    pass
                control.record_fault(error)
                return self.respond(503, {"message": "实机状态异常，请现场确认机械臂已停止"})
            return self.respond(200, result)

        def do_GET(self):
            self.dispatch()

        def do_POST(self):
            self.connection.settimeout(1)
            self.dispatch(post=True)

    try:
        arm.bus.connect()
        if arm.bus.read_calibration() != arm.calibration:
            raise RuntimeError("舵机校准值与文件不一致")
        if any(control.read_each("Operating_Mode").values()):
            raise RuntimeError("舵机需要处于位置模式")
        torque = control.read_each("Torque_Enable")
        for register in ("Goal_Velocity", "Acceleration"):
            control.read_each(register)
        position = control.read_feedback("Present_Position")
        moving = control.read_feedback("Moving")
        if any(torque.values()):
            if not args.resume_stopped_hold or not all(torque.values()) or any(moving.values()):
                raise RuntimeError("无法确认舵机已卸力或处于完整的静止保持状态")
            control.check_calibrated_pose(position)
            control.holding = True
            control.restored_hold = True
        if args.probe_only:
            print("只读检查通过：六轴位置、运动状态、速度、加速度和卸力状态均可读。", flush=True)
            return
        with ThreadingHTTPServer(("127.0.0.1", args.listen), Handler) as server:
            print("SO-101 已连接，等待操作员确认接管。", flush=True)
            server.serve_forever()
    finally:
        if arm.bus.is_connected:
            try:
                if control.holding:
                    control.stop()
            finally:
                arm.bus.disconnect(disable_torque=False)


if __name__ == "__main__":
    main()
