using System;
using System.Numerics;
using System.Collections.Generic;
using System.Linq;

namespace blazor_csharp_web.Models
{
    public class Particle
    {
        public Vector3 Position;
        public Vector3 OldPosition;
        public Vector3 InitialPosition;
        public bool IsRigid;
        public float Tension;
    }

    public class Constraint
    {
        public int P1;
        public int P2;
        public float RestLength;
    }

    public class Collider
    {
        public string Name;
        public Vector3 Position;
        public float Radius;
    }

    public class TshirtDynamics
    {
        public ClothConfiguration Config { get; private set; }
        public List<Particle> Particles { get; private set; } = new();
        public List<Constraint> Constraints { get; private set; } = new();
        public List<Collider> Colliders { get; private set; } = new();

        public float[] VertexPositions;
        public float[] VertexColors;

        public TshirtDynamics(ClothConfiguration config)
        {
            Config = config;
            // Arrays will be initialized once mesh data is received from JS
            VertexPositions = Array.Empty<float>();
            VertexColors = Array.Empty<float>();
        }

        public void InitializeFromMesh(float[] positions, int[] indices)
        {
            Particles.Clear();
            Constraints.Clear();

            // 1. Create Particles
            for (int i = 0; i < positions.Length; i += 3)
            {
                var pos = new Vector3(positions[i], positions[i + 1], positions[i + 2]);
                Particles.Add(new Particle
                {
                    Position = pos,
                    OldPosition = pos,
                    InitialPosition = pos,
                    // Fix the collar area (top of the shirt)
                    IsRigid = pos.Y > 1.5f 
                });
            }

            // 2. Create Constraints from Triangle Edges (Unique Edges Only)
            var edgeSet = new HashSet<(int, int)>();
            for (int i = 0; i < indices.Length; i += 3)
            {
                AddEdge(edgeSet, indices[i], indices[i + 1]);
                AddEdge(edgeSet, indices[i + 1], indices[i + 2]);
                AddEdge(edgeSet, indices[i + 2], indices[i]);
            }

            foreach (var edge in edgeSet)
            {
                float dist = Vector3.Distance(Particles[edge.Item1].Position, Particles[edge.Item2].Position);
                Constraints.Add(new Constraint { P1 = edge.Item1, P2 = edge.Item2, RestLength = dist });
            }

            VertexPositions = new float[Particles.Count * 3];
            VertexColors = new float[Particles.Count * 3];

            // 3. Setup Mannequin Colliders
            Colliders = new List<Collider>
            {
                new Collider { Name = "chest", Position = new Vector3(0, 1.35f, 0), Radius = 0.25f },
                new Collider { Name = "waist", Position = new Vector3(0, 1.1f, 0.05f), Radius = 0.20f },
                new Collider { Name = "shoulderL", Position = new Vector3(0.28f, 1.45f, 0), Radius = 0.12f },
                new Collider { Name = "shoulderR", Position = new Vector3(-0.28f, 1.45f, 0), Radius = 0.12f }
            };
        }

        private void AddEdge(HashSet<(int, int)> set, int a, int b)
        {
            if (a == b) return;
            var edge = a < b ? (a, b) : (b, a);
            set.Add(edge);
        }

        public void Update(float dt, double h, double w, double wa)
        {
            if (Particles.Count == 0) return;

            float hScale = 0.9f + (float)h * 0.2f;
            float wScale = 0.8f + (float)w * 0.4f;
            float waScale = 0.8f + (float)wa * 0.4f;

            // Update Colliders
            foreach (var c in Colliders)
            {
                c.Position.Y = (c.Name == "chest" ? 1.35f : c.Name == "waist" ? 1.1f : 0.9f) * hScale;
                // Waist collider reacts to waist slider, chest/shoulders to weight
                c.Radius = (c.Name == "waist" ? 0.18f * waScale : 0.24f * wScale);
            }

            Vector3 gravityVec = new Vector3(0, Config.Gravity * dt * dt, 0);

            // Integration
            for (int i = 0; i < Particles.Count; i++)
            {
                var p = Particles[i];
                p.Tension = 0f;

                if (p.IsRigid)
                {
                    // Fixed points follow the neck movement
                    p.Position = p.InitialPosition;
                    p.Position.Y *= hScale;
                    p.Position.X *= wScale;
                    p.Position.Z *= wScale;
                    continue;
                }
                
                Vector3 vel = (p.Position - p.OldPosition) * Config.Drag;
                p.OldPosition = p.Position;
                p.Position += vel + gravityVec;
            }

            // Solver
            for (int it = 0; it < Config.Iterations; it++)
            {
                foreach (var constraint in Constraints)
                {
                    var p1 = Particles[constraint.P1];
                    var p2 = Particles[constraint.P2];

                    float dynamicRestLength = constraint.RestLength * (1.0f + (float)(w + wa) * 0.02f);
                    Vector3 delta = p2.Position - p1.Position;
                    float len = delta.Length();
                    if (len == 0) continue;

                    float diff = (len - dynamicRestLength) / len;
                    if (len > dynamicRestLength) p1.Tension += (len - dynamicRestLength);

                    Vector3 adjust = delta * (diff * 0.5f * Config.Stiffness);
                    if (!p1.IsRigid) p1.Position += adjust;
                    if (!p2.IsRigid) p2.Position -= adjust;
                }

                foreach (var p in Particles)
                {
                    if (p.IsRigid) continue;
                    foreach (var col in Colliders)
                    {
                        Vector3 diff = p.Position - col.Position;
                        float dist = diff.Length();
                        if (dist < col.Radius)
                        {
                            Vector3 normal = diff / dist;
                            p.Position = col.Position + normal * col.Radius;
                            
                            // High Friction (Grip)
                            Vector3 move = p.Position - p.OldPosition;
                            Vector3 tangent = move - normal * Vector3.Dot(move, normal);
                            p.OldPosition += tangent * Config.Friction;
                        }
                    }
                }
            }

            // Final Output Mapping
            for (int i = 0; i < Particles.Count; i++)
            {
                var p = Particles[i];
                VertexPositions[i * 3] = p.Position.X;
                VertexPositions[i * 3 + 1] = p.Position.Y;
                VertexPositions[i * 3 + 2] = p.Position.Z;

                float stress = Math.Min(1.0f, p.Tension * 20.0f * (float)(wa > 0.8 ? 2 : 1));
                VertexColors[i * 3] = 0.9f + (stress * 0.1f);
                VertexColors[i * 3 + 1] = 0.9f - (stress * 0.7f);
                VertexColors[i * 3 + 2] = 0.9f - (stress * 0.7f);
            }
        }
    }
}
