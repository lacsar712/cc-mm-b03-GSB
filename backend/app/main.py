from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings
from sqlalchemy import DateTime, Float, String, create_engine, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.rules import classify


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg2://app:app@localhost:54391/methane"
    jwt_secret: str = "mine-methane-dev-secret"


settings = Settings()
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer(auto_error=False)
USERS = {
    "gasman": {"role": "writer", "password_hash": pwd.hash("gas123456")},
    "viewer": {"role": "reader", "password_hash": pwd.hash("view123456")},
}

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine)


class Base(DeclarativeBase):
    pass


class Reading(Base):
    __tablename__ = "readings"
    id: Mapped[int] = mapped_column(primary_key=True)
    site: Mapped[str] = mapped_column(String(80))
    ch4_pct: Mapped[float] = mapped_column(Float)
    level: Mapped[str] = mapped_column(String(20))
    note: Mapped[str] = mapped_column(String(200))
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Watch(Base):
    __tablename__ = "watches"
    id: Mapped[int] = mapped_column(primary_key=True)
    site: Mapped[str] = mapped_column(String(80), unique=True)


class WatchEvent(Base):
    __tablename__ = "watch_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    site: Mapped[str] = mapped_column(String(80), index=True)
    action: Mapped[str] = mapped_column(String(10))
    username: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class LoginIn(BaseModel):
    username: str
    password: str


class ReadingIn(BaseModel):
    site: str = Field(min_length=1, max_length=80)
    ch4_pct: float


class WatchIn(BaseModel):
    site: str = Field(min_length=1, max_length=80)


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> dict:
    if credentials is None:
        raise HTTPException(status_code=401, detail="未登录")
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=["HS256"])
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="无效令牌") from exc
    username = payload.get("sub")
    if username not in USERS:
        raise HTTPException(status_code=401, detail="无效令牌")
    return {"username": username, "role": payload.get("role")}


def require_writer(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "writer":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="仅瓦斯检查员可上报")
    return user


sockets: set[WebSocket] = set()
app = FastAPI(title="矿井瓦斯班测台")


@app.on_event("startup")
def startup():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if db.query(Reading).count() == 0:
            now = datetime.now(timezone.utc)
            for site, ch4 in (("东翼-12", 0.35), ("回风巷", 1.4)):
                level, note = classify(ch4)
                db.add(
                    Reading(
                        site=site,
                        ch4_pct=ch4,
                        level=level,
                        note=note,
                        created_by="gasman",
                        created_at=now,
                    )
                )
            db.commit()
    finally:
        db.close()


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "mine-methane-shift"}


@app.post("/api/auth/login")
def login(body: LoginIn):
    user = USERS.get(body.username.strip())
    if not user or not pwd.verify(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": body.username.strip(), "role": user["role"], "exp": exp},
        settings.jwt_secret,
        algorithm="HS256",
    )
    return {"access_token": token, "username": body.username.strip(), "role": user["role"]}


@app.get("/api/readings")
def list_readings(_user: dict = Depends(current_user)):
    db = SessionLocal()
    try:
        rows = db.query(Reading).order_by(Reading.id.desc()).all()
        return [
            {
                "id": r.id,
                "site": r.site,
                "ch4_pct": r.ch4_pct,
                "level": r.level,
                "note": r.note,
                "created_by": r.created_by,
            }
            for r in rows
        ]
    finally:
        db.close()


@app.post("/api/readings", status_code=201)
async def create_reading(body: ReadingIn, user: dict = Depends(require_writer)):
    level, note = classify(body.ch4_pct)
    db = SessionLocal()
    try:
        row = Reading(
            site=body.site.strip(),
            ch4_pct=body.ch4_pct,
            level=level,
            note=note,
            created_by=user["username"],
            created_at=datetime.now(timezone.utc),
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        payload = {"id": row.id, "site": row.site, "ch4_pct": row.ch4_pct, "level": row.level, "note": row.note}
    finally:
        db.close()
    dead = []
    for ws in list(sockets):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        sockets.discard(ws)
    return payload


@app.get("/api/watchlist")
def get_watchlist(_user: dict = Depends(current_user)):
    db = SessionLocal()
    try:
        watches = db.query(Watch).order_by(Watch.id).all()
        sites = [w.site for w in watches]
        latest: dict[str, Reading] = {}
        if sites:
            latest_ids = (
                select(func.max(Reading.id))
                .where(Reading.site.in_(sites))
                .group_by(Reading.site)
            )
            for r in db.query(Reading).filter(Reading.id.in_(latest_ids)).all():
                latest[r.site] = r
        return {
            "items": [
                {
                    "site": site,
                    "ch4_pct": latest[site].ch4_pct if site in latest else None,
                    "level": latest[site].level if site in latest else None,
                    "note": latest[site].note if site in latest else None,
                    "updated_at": latest[site].created_at if site in latest else None,
                }
                for site in sites
            ]
        }
    finally:
        db.close()


@app.post("/api/watchlist", status_code=201)
def add_watch(body: WatchIn, user: dict = Depends(require_writer)):
    site = body.site.strip()
    db = SessionLocal()
    try:
        if db.query(Watch).filter(Watch.site == site).first() is not None:
            raise HTTPException(status_code=409, detail="该测点已在关注名单")
        now = datetime.now(timezone.utc)
        db.add(Watch(site=site))
        db.add(
            WatchEvent(site=site, action="钉上", username=user["username"], created_at=now)
        )
        db.commit()
    finally:
        db.close()
    return {"site": site, "action": "钉上"}


@app.delete("/api/watchlist")
def remove_watch(site: str, user: dict = Depends(require_writer)):
    site = site.strip()
    db = SessionLocal()
    try:
        watch = db.query(Watch).filter(Watch.site == site).first()
        if watch is None:
            raise HTTPException(status_code=404, detail="该测点不在关注名单")
        db.delete(watch)
        db.add(
            WatchEvent(
                site=site,
                action="取下",
                username=user["username"],
                created_at=datetime.now(timezone.utc),
            )
        )
        db.commit()
    finally:
        db.close()
    return {"site": site, "action": "取下"}


@app.get("/api/watchlist/history")
def watch_history(_user: dict = Depends(current_user)):
    db = SessionLocal()
    try:
        rows = db.query(WatchEvent).order_by(WatchEvent.id.desc()).all()
        return [
            {
                "id": r.id,
                "site": r.site,
                "action": r.action,
                "username": r.username,
                "created_at": r.created_at,
            }
            for r in rows
        ]
    finally:
        db.close()


@app.websocket("/ws/alerts")
async def alerts(ws: WebSocket):
    await ws.accept()
    sockets.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        sockets.discard(ws)
