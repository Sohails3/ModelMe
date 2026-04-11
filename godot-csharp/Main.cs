using Godot;
using System.Collections.Generic;

public partial class Main : Node3D
{
    private const int Iters = 5;
    private const float Gravity = -9.81f;
    private const float Drag = 0.95f;
    private const float Stiffness = 0.5f;
    private const int Res = 15;
    private const float Width = 1.4f;
    private const float Height = 0.8f;

    private MeshInstance3D _clothMesh;
    private ImmediateMesh _immediateMesh;

    private List<Particle> _particles = new List<Particle>();
    private List<Constraint> _constraints = new List<Constraint>();
    private Collider[] _colliders;

    private Node3D _mannequinGroup;

    private HSlider _hSlider, _wSlider, _waistSlider;

    private class Particle
    {
        public Vector3 Pos;
        public Vector3 Old;
        public bool IsRigid;

        public Particle(float x, float y, float z)
        {
            Pos = new Vector3(x, y, z);
            Old = new Vector3(x, y, z);
            IsRigid = false;
        }
    }

    private class Constraint
    {
        public int A;
        public int B;
        public float Dist;

        public Constraint(int a, int b, float dist)
        {
            A = a;
            B = b;
            Dist = dist;
        }
    }

    private class Collider
    {
        public string Name;
        public Vector3 Pos;
        public float Radius;

        public Collider(string name, Vector3 pos, float radius)
        {
            Name = name;
            Pos = pos;
            Radius = radius;
        }
    }

    public override void _Ready()
    {
        SetupUI();
        SetupScene();

        _colliders = new Collider[]
        {
            new Collider("chest", new Vector3(0, 1.35f, 0), 0.25f),
            new Collider("waist", new Vector3(0, 1.1f, 0), 0.20f),
            new Collider("shoulderL", new Vector3(0.24f, 1.45f, 0), 0.12f),
            new Collider("shoulderR", new Vector3(-0.24f, 1.45f, 0), 0.12f)
        };

        InitCloth();
        UpdateMannequinAndColliders();
    }

    private void SetupUI()
    {
        var canvasLayer = new CanvasLayer();
        AddChild(canvasLayer);

        var vbox = new VBoxContainer();
        canvasLayer.AddChild(vbox);
        vbox.SetAnchorsPreset(Control.LayoutPreset.TopLeft);
        vbox.OffsetLeft = 20;
        vbox.OffsetTop = 20;

        _hSlider = CreateSlider(vbox, "Height", 0.0f, 1.0f, 0.5f);
        _wSlider = CreateSlider(vbox, "Weight", 0.0f, 1.0f, 0.5f);
        _waistSlider = CreateSlider(vbox, "Waist", 0.0f, 1.0f, 0.5f);
    }

    private HSlider CreateSlider(Control parent, string name, float min, float max, float value)
    {
        var label = new Label { Text = name };
        parent.AddChild(label);

        var slider = new HSlider
        {
            MinValue = min,
            MaxValue = max,
            Value = value,
            CustomMinimumSize = new Vector2(200, 20)
        };
        slider.ValueChanged += (v) => UpdateMannequinAndColliders();
        parent.AddChild(slider);

        return slider;
    }

    private void SetupScene()
    {
        var camera = new Camera3D();
        camera.Position = new Vector3(0, 1.2f, 3.5f);
        AddChild(camera);

        var dirLight = new DirectionalLight3D();
        dirLight.Position = new Vector3(1, 2, 3);
        dirLight.LookAt(Vector3.Zero);
        AddChild(dirLight);

        _mannequinGroup = new Node3D();
        AddChild(_mannequinGroup);

        var mannequinMesh = new MeshInstance3D
        {
            Mesh = new CapsuleMesh { Radius = 0.25f, Height = 1.8f },
            Position = new Vector3(0, 0.9f, 0)
        };
        _mannequinGroup.AddChild(mannequinMesh);
    }

    private void InitCloth()
    {
        _clothMesh = new MeshInstance3D();
        _immediateMesh = new ImmediateMesh();
        _clothMesh.Mesh = _immediateMesh;

        var material = new StandardMaterial3D
        {
            AlbedoColor = new Color(1, 0, 0),
            CullMode = BaseMaterial3D.CullModeEnum.Disabled
        };
        _clothMesh.MaterialOverride = material;
        AddChild(_clothMesh);

        int res = Res + 1;

        for (int i = 0; i < res * res; i++)
        {
            float u = (float)(i % res) / Res;
            float v = (float)(i / res) / Res;

            float angle = u * Mathf.Pi * 2.0f;
            float r = 0.3f;
            float px = Mathf.Cos(angle) * r;
            float pz = Mathf.Sin(angle) * r;
            float py = v * Height + 0.85f;

            var p = new Particle(px, py, pz);
            if (v > 0.5f) p.IsRigid = true;
            _particles.Add(p);
        }

        for (int y = 0; y < res; y++)
        {
            for (int x = 0; x < res; x++)
            {
                int i = y * res + x;
                if (x < Res) AddConstraint(i, i + 1);
                if (y < Res) AddConstraint(i, i + res);
                if (x == 0) AddConstraint(i, y * res + Res);
            }
        }
    }

    private void AddConstraint(int a, int b)
    {
        float d = _particles[a].Pos.DistanceTo(_particles[b].Pos);
        _constraints.Add(new Constraint(a, b, d));
    }

    public override void _PhysicsProcess(double delta)
    {
        UpdateCloth(0.016f);
        DrawCloth();
    }

    private void UpdateCloth(float dt)
    {
        Vector3 gravityVec = new Vector3(0, Gravity * dt * dt, 0);

        foreach (var p in _particles)
        {
            if (p.IsRigid) continue;
            Vector3 vel = (p.Pos - p.Old) * Drag;
            p.Old = p.Pos;
            p.Pos = p.Pos + vel + gravityVec;
        }

        for (int i = 0; i < Iters; i++)
        {
            foreach (var c in _constraints)
            {
                var p1 = _particles[c.A];
                var p2 = _particles[c.B];
                Vector3 delta = p2.Pos - p1.Pos;
                float len = delta.Length();
                if (len == 0) continue;
                float diff = (len - c.Dist) / len;
                Vector3 adjust = delta * (diff * 0.5f * Stiffness);

                if (!p1.IsRigid) p1.Pos += adjust;
                if (!p2.IsRigid) p2.Pos -= adjust;
            }

            SolveCollisions();
        }
    }

    private void SolveCollisions()
    {
        foreach (var p in _particles)
        {
            if (p.IsRigid) continue;
            foreach (var c in _colliders)
            {
                float dist = p.Pos.DistanceTo(c.Pos);
                if (dist < c.Radius)
                {
                    p.Pos = c.Pos + (p.Pos - c.Pos).Normalized() * c.Radius;
                }
            }
        }
    }

    private void DrawCloth()
    {
        _immediateMesh.ClearSurfaces();
        _immediateMesh.SurfaceBegin(Mesh.PrimitiveType.Triangles);

        int res = Res + 1;
        for (int y = 0; y < Res; y++)
        {
            for (int x = 0; x < Res; x++)
            {
                int i0 = y * res + x;
                int i1 = y * res + (x + 1);
                int i2 = (y + 1) * res + x;
                int i3 = (y + 1) * res + (x + 1);

                var p0 = _particles[i0].Pos;
                var p1 = _particles[i1].Pos;
                var p2 = _particles[i2].Pos;
                var p3 = _particles[i3].Pos;

                // Triangle 1 (p0, p2, p1)
                Vector3 n1 = (p2 - p0).Cross(p1 - p0).Normalized();
                _immediateMesh.SurfaceSetNormal(n1);
                _immediateMesh.SurfaceAddVertex(p0);
                _immediateMesh.SurfaceSetNormal(n1);
                _immediateMesh.SurfaceAddVertex(p2);
                _immediateMesh.SurfaceSetNormal(n1);
                _immediateMesh.SurfaceAddVertex(p1);

                // Triangle 2 (p1, p2, p3)
                Vector3 n2 = (p2 - p1).Cross(p3 - p1).Normalized();
                _immediateMesh.SurfaceSetNormal(n2);
                _immediateMesh.SurfaceAddVertex(p1);
                _immediateMesh.SurfaceSetNormal(n2);
                _immediateMesh.SurfaceAddVertex(p2);
                _immediateMesh.SurfaceSetNormal(n2);
                _immediateMesh.SurfaceAddVertex(p3);
            }
        }

        _immediateMesh.SurfaceEnd();
    }

    private void UpdateMannequinAndColliders()
    {
        if (_hSlider == null) return;
        
        float h = (float)_hSlider.Value;
        float w = (float)_wSlider.Value;
        float wa = (float)_waistSlider.Value;

        float hS = 0.9f + h * 0.2f;
        float wS = 0.8f + w * 0.4f;
        float waS = 0.8f + wa * 0.4f;

        _mannequinGroup.Scale = new Vector3(wS, hS, wS);

        foreach (var c in _colliders)
        {
            c.Pos.Y = (c.Name == "chest" ? 1.35f : c.Name == "waist" ? 1.1f : 0.9f) * hS;
            c.Radius = (c.Name == "waist" ? 0.18f * waS : 0.24f * wS);
        }

        float neckY = 1.65f * hS;
        int res = Res + 1;

        for (int i = 0; i < _particles.Count; i++)
        {
            var p = _particles[i];
            if (p.IsRigid)
            {
                float v = (float)(i / res) / Res;
                p.Pos.Y = neckY - (1.0f - v) * 0.4f * hS;
            }
        }
    }
}
