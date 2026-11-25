"""Local MuJoCo service for the SO-101 course model."""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import logging
import math
from pathlib import Path
from threading import Lock
from uuid import uuid4

import mujoco
import numpy as np
from PIL import Image


WIDTH, HEIGHT = 1200, 800
TURN_LIMIT = 20
TRAVEL_LIMIT_MM = 40
ELEVATION_LIMIT_MM = 30
PITCH_LIMIT_DEGREES = 10
LINEAR_STEP_MM = 5
DIRECTIONS = {
    "LEFT": (-1, 0, 0, 0, "镜头已向左微调"),
    "RIGHT": (1, 0, 0, 0, "镜头已向右微调"),
    "FORWARD": (0, LINEAR_STEP_MM, 0, 0, "镜头已向前微调"),
    "BACKWARD": (0, -LINEAR_STEP_MM, 0, 0, "镜头已向后微调"),
    "UP": (0, 0, LINEAR_STEP_MM, 0, "镜头已上升"),
    "DOWN": (0, 0, -LINEAR_STEP_MM, 0, "镜头已下降"),
    "PITCH_UP": (0, 0, 0, 1, "镜头已抬头"),
    "PITCH_DOWN": (0, 0, 0, -1, "镜头已低头"),
}


@dataclass(frozen=True)
class Pose:
    pan_degrees: int = 0
    travel_mm: int = 0
    elevation_mm: int = 0
    pitch_degrees: int = 0


def camera_axes(forward):
    forward = np.asarray(forward, dtype=float)
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, [0, 0, 1])
    right /= np.linalg.norm(right)
    return right, np.cross(right, forward)


class CourseRenderer:
    def __init__(self, scene, fovy):
        spec = mujoco.MjSpec.from_file(str(scene))
        home_model = spec.compile()
        home_data = mujoco.MjData(home_model)
        mujoco.mj_forward(home_model, home_data)

        # Provisional mount: offset in front of the gripper and level at home.
        gripper_rotation = home_data.body("gripper").xmat.reshape(3, 3)
        right, up = camera_axes([1, 0, 0])
        spec.body("gripper").add_camera(
            name="lensmind_wrist",
            pos=gripper_rotation.T @ [0.09, 0, 0.04],
            xyaxes=np.r_[gripper_rotation.T @ right, gripper_rotation.T @ up],
            fovy=fovy,
        )

        observer = np.array([0.79, -0.65, 0.53])
        right, up = camera_axes(np.array([0.18, 0, 0.14]) - observer)
        spec.worldbody.add_camera(
            name="lensmind_observer", pos=observer, xyaxes=np.r_[right, up], fovy=39,
        )
        self.add_photo_scene(spec.worldbody)
        self.model = spec.compile()
        self.model.vis.global_.offwidth = WIDTH
        self.model.vis.global_.offheight = HEIGHT
        self.data = mujoco.MjData(self.model)
        pan = self.model.joint("shoulder_pan").id
        self.pan_address = self.model.jnt_qposadr[pan]
        self.pan_limits = self.model.jnt_range[pan]
        pitch_joints = [self.model.joint(name).id for name in ("shoulder_lift", "elbow_flex", "wrist_flex")]
        self.pitch_addresses = self.model.jnt_qposadr[pitch_joints]
        self.pitch_dofs = self.model.jnt_dofadr[pitch_joints]
        self.pitch_limits = self.model.jnt_range[pitch_joints]
        self.gripper_id = self.model.body("gripper").id
        self.wrist = self.data.camera("lensmind_wrist")
        mujoco.mj_forward(self.model, self.data)
        self.home_camera_xz = self.wrist.xpos[[0, 2]]
        # The course pan axis points down. A negative joint change turns the
        # level forward-facing camera left, toward world +Y.
        self.renderer = mujoco.Renderer(self.model, height=HEIGHT, width=WIDTH)

    @staticmethod
    def add_photo_scene(world):
        world.add_geom(name="backdrop", type=mujoco.mjtGeom.mjGEOM_BOX,
                       pos=[2.20, 0, 0.70], size=[0.04, 2, 0.70],
                       rgba=[0.73, 0.76, 0.69, 1])
        for y, color in [(-0.52, [0.71, 0.38, 0.23, 1]), (0.52, [0.30, 0.55, 0.44, 1])]:
            world.add_geom(type=mujoco.mjtGeom.mjGEOM_BOX, pos=[2.12, y, 0.47],
                           size=[0.025, 0.11, 0.47], rgba=color)
        world.add_geom(name="portrait_torso", type=mujoco.mjtGeom.mjGEOM_ELLIPSOID,
                       pos=[1.65, 0, 0.21], size=[0.085, 0.16, 0.24], rgba=[0.27, 0.38, 0.51, 1])
        world.add_geom(name="portrait_head", type=mujoco.mjtGeom.mjGEOM_ELLIPSOID,
                       pos=[1.65, 0, 0.53], size=[0.077, 0.082, 0.108], rgba=[0.83, 0.64, 0.46, 1])

    def set_camera_pose(self, pose):
        """Solve for the camera center and pitch in the zero-pan plane."""
        if pose.travel_mm == 0 and pose.elevation_mm == 0 and pose.pitch_degrees == 0:
            return
        # Solve in the zero-pan plane, then rotate the whole pose about the pan axis.
        target_xz = self.home_camera_xz + np.array([pose.travel_mm, pose.elevation_mm]) / 1000
        target_pitch = math.radians(pose.pitch_degrees)
        pitch_weight = 0.15  # Metres per radian, for the weighted least-squares error.
        position_jac = np.zeros((3, self.model.nv))
        rotation_jac = np.zeros_like(position_jac)
        for _ in range(30):
            mujoco.mj_forward(self.model, self.data)
            forward = -self.wrist.xmat.reshape(3, 3)[:, 2]
            pitch = math.atan2(forward[2], forward[0])
            error = np.r_[target_xz - self.wrist.xpos[[0, 2]], pitch_weight * (target_pitch - pitch)]
            if np.linalg.norm(error) < 0.00005:
                return
            mujoco.mj_jac(self.model, self.data, position_jac, rotation_jac, self.wrist.xpos, self.gripper_id)
            jac = np.vstack((position_jac[[0, 2]][:, self.pitch_dofs],
                             -pitch_weight * rotation_jac[1, self.pitch_dofs]))
            delta = jac.T @ np.linalg.solve(jac @ jac.T + 1e-6 * np.eye(3), error)
            qpos = self.data.qpos[self.pitch_addresses] + np.clip(delta, -0.1, 0.1)
            self.data.qpos[self.pitch_addresses] = np.clip(qpos, self.pitch_limits[:, 0], self.pitch_limits[:, 1])
        raise DeviceError(HTTPStatus.CONFLICT, "当前模型无法同时达到指定的镜头位置和俯仰角")

    def render(self, pose):
        radians = math.radians(pose.pan_degrees)
        if not self.pan_limits[0] <= radians <= self.pan_limits[1]:
            raise RuntimeError("Pan is outside the course model's joint limits")
        mujoco.mj_resetData(self.model, self.data)
        self.set_camera_pose(pose)
        self.data.qpos[self.pan_address] = radians
        mujoco.mj_forward(self.model, self.data)
        forward = -self.wrist.xmat.reshape(3, 3)[:, 2]
        yaw = math.degrees(math.atan2(forward[1], forward[0]))
        pitch = math.degrees(math.atan2(forward[2], math.hypot(forward[0], forward[1])))
        self.renderer.update_scene(self.data, camera="lensmind_wrist")
        frame = self.encode(Image.fromarray(self.renderer.render()), "PNG")
        self.renderer.update_scene(self.data, camera="lensmind_observer")
        observer = Image.fromarray(self.renderer.render()).resize((480, 320), Image.Resampling.LANCZOS)
        return {
            "frame": {"id": str(uuid4()), "timestamp": datetime.now(timezone.utc).isoformat(),
                      "width": WIDTH, "height": HEIGHT, "src": frame},
            "so101": {"shoulderPanDegrees": pose.pan_degrees, "cameraYawDegrees": round(yaw, 4),
                      "cameraTravelMillimeters": pose.travel_mm, "cameraElevationMillimeters": pose.elevation_mm,
                      "cameraPitchDegrees": round(pitch, 4),
                      "cameraPositionMeters": self.wrist.xpos.round(7).tolist(),
                      "armView": self.encode(observer, "JPEG")},
        }

    @staticmethod
    def encode(image, image_format):
        with BytesIO() as output:
            image.save(output, format=image_format)
            return f"data:image/{image_format.lower()};base64," + base64.b64encode(output.getvalue()).decode("ascii")

    def close(self):
        self.renderer.close()


class DeviceError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class SimulatedArm:
    def __init__(self, render):
        self.render = render
        self.lock = Lock()
        self.pose = Pose()
        self.rendered = render(self.pose)
        self.stopped = False
        self.busy = False
        self.revision = 0
        self.message = "SO-101 三维仿真已连接"

    def snapshot(self):
        return {"mode": "MOCK", "connected": True, "x": self.pose.pan_degrees, "y": 0,
                "state": "STOPPED" if self.stopped else "MOVING" if self.busy else "IDLE",
                "message": self.message, **self.rendered}

    def status(self):
        with self.lock:
            return self.snapshot()

    def stop(self):
        with self.lock:
            self.stopped = True
            self.revision += 1
            self.message = "SO-101 仿真已停止，回初始位后恢复操作"
            return self.snapshot()

    def move(self, direction, step):
        if not isinstance(direction, str) or direction not in DIRECTIONS or type(step) is not int or not 1 <= step <= 5:
            raise DeviceError(HTTPStatus.BAD_REQUEST, "三维仿真支持六向微调和抬头、低头，步长为整数 1～5")
        return self.change_pose(direction, step)

    def home(self):
        return self.change_pose(None, 0)

    def change_pose(self, direction, step):
        home = direction is None
        with self.lock:
            if self.stopped and not home:
                raise DeviceError(HTTPStatus.CONFLICT, "仿真已停止，请先回初始位")
            if self.busy:
                raise DeviceError(HTTPStatus.CONFLICT, "上一操作仍在结束，请稍后重试")
            if home:
                target, message = Pose(), "已回仿真初始位"
            else:
                pan, travel, elevation, pitch, message = DIRECTIONS[direction]
                target = Pose(
                    self.pose.pan_degrees + pan * step,
                    self.pose.travel_mm + travel * step,
                    self.pose.elevation_mm + elevation * step,
                    self.pose.pitch_degrees + pitch * step,
                )
            if abs(target.pan_degrees) > TURN_LIMIT:
                raise DeviceError(HTTPStatus.CONFLICT, "超出镜头左右各 20° 的仿真范围")
            if abs(target.travel_mm) > TRAVEL_LIMIT_MM:
                raise DeviceError(HTTPStatus.CONFLICT, "超出镜头前后各 40 mm 的仿真范围")
            if abs(target.elevation_mm) > ELEVATION_LIMIT_MM:
                raise DeviceError(HTTPStatus.CONFLICT, "超出镜头上下各 30 mm 的仿真范围")
            if abs(target.pitch_degrees) > PITCH_LIMIT_DEGREES:
                raise DeviceError(HTTPStatus.CONFLICT, "超出镜头抬头和低头各 10° 的仿真范围")
            same_pose = target == self.pose
            revision = self.revision
            self.busy = True
            self.message = "正在更新 SO-101 仿真机位"

        try:
            rendered = self.rendered if same_pose else self.render(target)
        except Exception as error:
            with self.lock:
                self.busy = False
                if not self.stopped:
                    self.message = str(error) if isinstance(error, DeviceError) else "仿真画面生成失败，机位未更新"
            raise

        with self.lock:
            self.busy = False
            if revision != self.revision:
                raise DeviceError(HTTPStatus.CONFLICT, "操作已被停止指令取消")
            self.pose, self.rendered = target, rendered
            self.stopped = False
            self.message = message
            return self.snapshot()


def make_handler(arm):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/status":
                self.reply(HTTPStatus.OK, arm.status())
            else:
                self.reply(HTTPStatus.NOT_FOUND, {"message": "未知设备接口"})

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if self.headers.get_content_type() != "application/json" or not 0 < length <= 4096:
                    raise DeviceError(HTTPStatus.BAD_REQUEST, "设备请求需要 JSON")
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("Expected a JSON object")
                if self.path == "/move":
                    result = arm.move(body.get("direction"), body.get("step"))
                elif self.path == "/home":
                    result = arm.home()
                elif self.path == "/stop":
                    result = arm.stop()
                else:
                    raise DeviceError(HTTPStatus.NOT_FOUND, "未知设备接口")
            except DeviceError as error:
                self.reply(error.code, {"message": str(error)})
            except ValueError:
                self.reply(HTTPStatus.BAD_REQUEST, {"message": "设备请求参数无效"})
            except Exception:
                logging.exception("SO-101 simulation request failed")
                self.reply(HTTPStatus.INTERNAL_SERVER_ERROR, {"message": "MuJoCo 仿真失败"})
            else:
                self.reply(HTTPStatus.OK, result)

        def reply(self, code, body):
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", type=Path, required=True, help="Path to course SO101/scene.xml")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--fovy", type=float, default=45, help="Provisional vertical field of view in degrees")
    args = parser.parse_args()
    if not 0 < args.fovy < 180:
        parser.error("--fovy must be between 0 and 180 degrees")
    if not args.scene.is_file():
        parser.error("--scene must point to the course scene.xml")

    # Keep creation, rendering and cleanup on the same OpenGL thread.
    with ThreadPoolExecutor(max_workers=1) as worker:
        renderer = worker.submit(CourseRenderer, args.scene.resolve(), args.fovy).result()
        try:
            arm = SimulatedArm(lambda pose: worker.submit(renderer.render, pose).result())
            with ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(arm)) as server:
                print(f"SO-101 MuJoCo simulation listening on http://127.0.0.1:{server.server_port}", flush=True)
                server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            worker.submit(renderer.close).result()


if __name__ == "__main__":
    main()
