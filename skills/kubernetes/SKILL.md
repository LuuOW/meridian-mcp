---
name: kubernetes
description: Kubernetes orchestration authority — pods, deployments, services, ingress, helm charts, kustomize overlays, RBAC, network policies, operators, StatefulSets for databases, production-grade cluster hardening, and kubectl workflows
---

# kubernetes

Production Kubernetes orchestration: pod scheduling, service discovery, Helm release management, RBAC, and cluster hardening. Covers EKS / GKE / AKS plus on-prem k3s and kind for local dev.

## Core Objects

```yaml
# deployment.yaml — stateless app, horizontally scalable
apiVersion: apps/v1
kind: Deployment
metadata: { name: api, labels: { app: api } }
spec:
  replicas: 3
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
      - name: api
        image: ghcr.io/myorg/api:v1.2.3
        ports: [ { containerPort: 8080 } ]
        resources:
          requests: { cpu: "100m", memory: "256Mi" }
          limits:   { cpu: "500m", memory: "512Mi" }
        livenessProbe:
          httpGet: { path: /health, port: 8080 }
          initialDelaySeconds: 10
          periodSeconds: 15
        readinessProbe:
          httpGet: { path: /ready, port: 8080 }
```

## Services and Ingress

```yaml
apiVersion: v1
kind: Service
metadata: { name: api }
spec:
  selector: { app: api }
  ports: [ { port: 80, targetPort: 8080 } ]
  type: ClusterIP   # internal; use LoadBalancer for external
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
    nginx.ingress.kubernetes.io/rate-limit: "100"   # req/min per IP
spec:
  ingressClassName: nginx
  tls: [ { hosts: [api.example.com], secretName: api-tls } ]
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend: { service: { name: api, port: { number: 80 } } }
```

## Helm Chart Structure

Helm is the package manager. Chart templates parameterise everything per environment.

```
charts/api/
├── Chart.yaml
├── values.yaml          # defaults
├── values-prod.yaml     # override per env
└── templates/
    ├── deployment.yaml
    ├── service.yaml
    ├── ingress.yaml
    ├── hpa.yaml
    └── _helpers.tpl
```

```yaml
# values.yaml
image:
  repository: ghcr.io/myorg/api
  tag: v1.2.3
replicas: 3
resources:
  requests: { cpu: 100m, memory: 256Mi }
  limits:   { cpu: 500m, memory: 512Mi }
```

```bash
helm install api ./charts/api --namespace prod --values values-prod.yaml
helm upgrade --atomic --wait api ./charts/api -n prod -f values-prod.yaml
helm rollback api 1 -n prod    # roll back to revision 1
helm history api -n prod
```

## Horizontal Pod Autoscaling

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: api }
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target: { type: Utilization, averageUtilization: 70 }
```

Custom metrics (requests/sec, queue depth) require the Prometheus Adapter.

## StatefulSets for Databases

Postgres, Kafka, Redis cluster — anything with persistent identity and storage.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: postgres }
spec:
  serviceName: postgres
  replicas: 1
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers:
      - name: postgres
        image: postgres:16
        volumeMounts: [ { name: data, mountPath: /var/lib/postgresql/data } ]
  volumeClaimTemplates:
  - metadata: { name: data }
    spec:
      accessModes: [ReadWriteOnce]
      resources: { requests: { storage: 50Gi } }
      storageClassName: gp3
```

## RBAC — Service Accounts and Roles

```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: api-sa, namespace: prod }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: api-role, namespace: prod }
rules:
- apiGroups: [""]
  resources: [configmaps, secrets]
  resourceNames: [api-config, api-secrets]   # scope narrowly
  verbs: [get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: api-rb, namespace: prod }
subjects: [ { kind: ServiceAccount, name: api-sa, namespace: prod } ]
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: api-role }
```

## Network Policies

Default-deny, explicitly allow. Without these, every pod can talk to every other pod.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny, namespace: prod }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: api-allow, namespace: prod }
spec:
  podSelector: { matchLabels: { app: api } }
  ingress:
  - from: [ { podSelector: { matchLabels: { app: nginx } } } ]
    ports: [ { port: 8080 } ]
  egress:
  - to: [ { podSelector: { matchLabels: { app: postgres } } } ]
    ports: [ { port: 5432 } ]
```

## Kubectl Daily Workflows

```bash
# context + namespace
kubectl config use-context prod-cluster
kubectl config set-context --current --namespace=prod

# inspect
kubectl get pods -l app=api -o wide
kubectl describe pod api-6d7b-xyz
kubectl logs -f api-6d7b-xyz --tail 100
kubectl logs -l app=api --all-containers --prefix --tail 50

# exec + port-forward for debugging
kubectl exec -it api-6d7b-xyz -- /bin/sh
kubectl port-forward svc/api 8080:80

# rollout
kubectl rollout status deploy/api
kubectl rollout history deploy/api
kubectl rollout undo deploy/api --to-revision=3

# events (first place to look when things break)
kubectl get events --sort-by='.lastTimestamp' --all-namespaces

# resource usage
kubectl top pods
kubectl top nodes
```

## Operators and CRDs

Operator = Deployment + Custom Resource Definition, automates lifecycle of a stateful thing.

Common operators: cert-manager (TLS), external-dns (Route53 sync), prometheus-operator (observability), cnpg (Postgres), strimzi (Kafka).

## Production Hardening

- [ ] All pods have `resources.requests` and `resources.limits`
- [ ] `livenessProbe` + `readinessProbe` on every workload
- [ ] `runAsNonRoot: true` + `readOnlyRootFilesystem: true` in `securityContext`
- [ ] PodDisruptionBudgets on critical workloads
- [ ] NetworkPolicies in default-deny mode per namespace
- [ ] Secrets via external-secrets-operator (Vault / AWS SM), never plain k8s Secrets in git
- [ ] Images pinned by SHA256 digest, not just tag
- [ ] RBAC scoped to least privilege per ServiceAccount
- [ ] Cluster autoscaler + HPA on every autoscaling-capable workload
- [ ] Regular `kubectl get pods --all-namespaces | grep -v Running` to spot drift
